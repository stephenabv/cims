import { constants, createPublicKey, publicEncrypt, randomUUID } from 'node:crypto';
import {
  Client,
  createTestApp,
  createUser,
  loginPrivileged,
  resetData,
  type TestContext,
  type TestUser,
} from './helpers';

/** Instants in Asia/Manila (UTC+8). 2026-11-04 is a Wednesday. */
const manila = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);

describe('Offline attendance sync (integration)', () => {
  let ctx: TestContext;
  let token: string;
  let key: { keyId: string; publicKeySpki: string };

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.prisma.$disconnect();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetData(ctx.prisma);
    ctx.clock.set(manila('2026-11-05', '10:00'));
    const it = await createUser(ctx.prisma, { role: 'IT_ADMIN' });
    const c = new Client(ctx.app);
    await loginPrivileged(c, it, ctx.clock);
    token = (await c.post('/kiosk-devices', { name: 'Lobby tablet' })).body.token;
    key = (await new Client(ctx.app).kiosk('/kiosk/sync-key', undefined, token)).body;
  });

  const client = () => new Client(ctx.app);

  /** Encrypts a punch the way the kiosk does (RSA-OAEP, SHA-256). */
  function item(
    user: Pick<TestUser, 'accountNumber' | 'pin'>,
    type: 'TIME_IN' | 'TIME_OUT',
    occurredAt: Date,
    overrides: Record<string, unknown> = {},
  ) {
    const clientUuid = randomUUID();
    const payload = JSON.stringify({
      v: 1,
      clientUuid,
      accountNumber: user.accountNumber,
      pin: user.pin,
      type,
      occurredAt: occurredAt.toISOString(),
      ...overrides,
    });
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpki, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const ciphertext = publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(payload),
    ).toString('base64');
    return { clientUuid, keyId: key.keyId, ciphertext };
  }
  const sync = (items: object[]) => client().kiosk('/kiosk/sync', { items }, token);
  const statuses = (res: { body: { results: { status: string; reason?: string }[] } }) =>
    res.body.results.map((r) => (r.reason ? `${r.status}:${r.reason}` : r.status));

  const asHr = async () => {
    const hr = await createUser(ctx.prisma, { role: 'HR' });
    const c = client();
    await loginPrivileged(c, hr, ctx.clock);
    return c;
  };

  it('serves the public key only to registered devices', async () => {
    expect(key.publicKeySpki).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect((await client().kiosk('/kiosk/sync-key')).status).toBe(401);
    await ctx.prisma.companySetting.create({
      data: { key: 'attendance.allowUnregisteredDevices', value: true },
    });
    const staff = await createUser(ctx.prisma);
    // Unregistered browsers may punch online when allowed, but never queue offline punches.
    expect(
      (
        await client().kiosk('/kiosk/sync', {
          items: [item(staff, 'TIME_IN', manila('2026-11-05', '08:00'))],
        })
      ).status,
    ).toBe(401);
  });

  it('applies a day recorded offline, oldest first, and is idempotent on retry', async () => {
    const staff = await createUser(ctx.prisma);
    // Sent out of order on purpose: the server sorts by the original device time.
    const items = [
      item(staff, 'TIME_OUT', manila('2026-11-04', '17:05')),
      item(staff, 'TIME_IN', manila('2026-11-04', '08:10')),
    ];
    const res = await sync(items);
    expect(res.status).toBe(200);
    expect(statuses(res)).toEqual(['APPLIED', 'APPLIED']);

    const day = await ctx.prisma.attendanceDay.findFirstOrThrow({
      where: { employeeId: staff.employeeId },
    });
    expect(day).toMatchObject({ status: 'PRESENT', lateMinutes: 0, hasOpenPunch: false });
    const events = await ctx.prisma.attendanceEvent.findMany({
      where: { employeeId: staff.employeeId },
    });
    expect(
      events.every(
        (e) =>
          e.source === 'KIOSK_OFFLINE' &&
          e.recordedAt.getTime() === manila('2026-11-05', '10:00').getTime(),
      ),
    ).toBe(true);

    expect(statuses(await sync(items))).toEqual(['DUPLICATE', 'DUPLICATE']);
    expect(await ctx.prisma.attendanceEvent.count()).toBe(2);
    const batches = await ctx.prisma.syncBatch.findMany({ orderBy: { receivedAt: 'asc' } });
    expect(batches.map((b) => [b.applied, b.duplicates])).toEqual([
      [2, 0],
      [0, 2],
    ]);
  });

  it('rejects items it cannot trust and defers locked PINs', async () => {
    const staff = await createUser(ctx.prisma);
    const good = item(staff, 'TIME_IN', manila('2026-11-05', '08:00'));
    const tampered = {
      ...item(staff, 'TIME_IN', manila('2026-11-05', '08:00')),
      ciphertext: Buffer.from('x'.repeat(384)).toString('base64'),
    };
    const swappedId = {
      ...item(staff, 'TIME_IN', manila('2026-11-05', '08:00')),
      clientUuid: randomUUID(),
    };
    const res = await sync([
      item({ ...staff, pin: '111222' }, 'TIME_IN', manila('2026-11-05', '08:00')),
      tampered,
      swappedId,
      item(staff, 'TIME_IN', manila('2026-11-05', '10:30')),
      good,
    ]);
    expect(statuses(res)).toEqual([
      'REJECTED:INVALID_CREDENTIALS',
      'REJECTED:INVALID_PAYLOAD',
      'REJECTED:INVALID_PAYLOAD',
      'REJECTED:FUTURE_TIMESTAMP',
      'APPLIED',
    ]);

    const locked = await createUser(ctx.prisma);
    await ctx.prisma.userAccount.update({
      where: { id: locked.userId },
      data: { pinLockedUntil: manila('2026-11-05', '10:15'), failedPinCount: 5 },
    });
    expect(statuses(await sync([item(locked, 'TIME_IN', manila('2026-11-05', '08:00'))]))).toEqual([
      'DEFERRED:PIN_LOCKED',
    ]);

    const suspended = await createUser(ctx.prisma, { status: 'SUSPENDED' });
    expect(
      statuses(await sync([item(suspended, 'TIME_IN', manila('2026-11-05', '08:00'))])),
    ).toEqual(['REJECTED:ACCOUNT_INACTIVE']);
  });

  it('keeps contradicting punches for HR, who accepts or rejects them with a reason', async () => {
    await ctx.prisma.companySetting.create({
      data: { key: 'attendance.allowUnregisteredDevices', value: true },
    });
    const staff = await createUser(ctx.prisma);
    ctx.clock.set(manila('2026-11-05', '08:00'));
    await client().kiosk(
      '/kiosk/punch',
      { accountNumber: staff.accountNumber, pin: staff.pin, type: 'TIME_IN' },
      token,
    );
    ctx.clock.set(manila('2026-11-05', '10:00'));

    const res = await sync([
      item(staff, 'TIME_IN', manila('2026-11-05', '09:00')),
      item(staff, 'TIME_IN', manila('2026-11-01', '08:00')),
    ]);
    expect(statuses(res)).toEqual(['CONFLICT:ALREADY_TIMED_IN', 'CONFLICT:TOO_OLD']);
    // Conflicting punches do not change the computed day.
    const before = await ctx.prisma.attendanceDay.findMany({
      where: { employeeId: staff.employeeId },
    });
    expect(before).toHaveLength(1);

    const staffClient = client();
    await staffClient.login(staff);
    expect((await staffClient.get('/attendance/conflicts')).status).toBe(403);

    const hr = await asHr();
    const list = await hr.get('/attendance/conflicts');
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(2);
    const [tooOld, alreadyIn] = list.body.data as {
      id: string;
      reason: string;
      punch: { workDate: string; device: string };
    }[];
    expect(tooOld).toMatchObject({
      reason: 'TOO_OLD',
      punch: { workDate: '2026-11-01', device: 'Lobby tablet' },
    });
    expect(alreadyIn!.reason).toBe('ALREADY_TIMED_IN');

    expect(
      (
        await hr.post(`/attendance/conflicts/${alreadyIn!.id}/resolve`, {
          decision: 'REJECT',
          note: '',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await hr.post(`/attendance/conflicts/${alreadyIn!.id}/resolve`, {
          decision: 'REJECT',
          note: 'Duplicate of the online time-in',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await hr.post(`/attendance/conflicts/${alreadyIn!.id}/resolve`, {
          decision: 'ACCEPT',
          note: 'Changed my mind',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await hr.post(`/attendance/conflicts/${tooOld!.id}/resolve`, {
          decision: 'ACCEPT',
          note: 'Kiosk was offline over the long weekend',
        })
      ).status,
    ).toBe(204);

    const events = await ctx.prisma.attendanceEvent.findMany({
      where: { source: 'KIOSK_OFFLINE' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.status)).toEqual(['ACCEPTED', 'VOIDED']);
    expect(events[1]!.voidReason).toBe('Duplicate of the online time-in');
    const nov1 = await ctx.prisma.attendanceDay.findFirstOrThrow({
      where: { employeeId: staff.employeeId, workDate: new Date('2026-11-01T00:00:00Z') },
    });
    expect(nov1.hasOpenPunch).toBe(true);

    const resolved = await hr.get('/attendance/conflicts?status=REJECTED');
    expect(resolved.body.data[0].resolution).toMatchObject({
      note: 'Duplicate of the online time-in',
    });
    expect(resolved.body.data[0].resolution.by).toMatch(/^Test User/);
    await expect(ctx.prisma.attendanceConflict.deleteMany()).rejects.toThrow();
  });

  it('decides time in or out on sync for presses of the unified button (v2)', async () => {
    ctx.clock.set(manila('2026-11-05', '19:00'));
    const staff = await createUser(ctx.prisma);
    const auto = (at: Date) => item(staff, 'TIME_IN', at, { v: 2, type: undefined });
    const res = await sync([
      auto(manila('2026-11-05', '07:55')),
      // Pressed twice by accident: the second press is a duplicate, not a time out.
      auto(new Date(manila('2026-11-05', '07:55').getTime() + 20_000)),
      auto(manila('2026-11-05', '17:05')),
      // A press after the shift is complete is kept for HR, never applied silently.
      auto(manila('2026-11-05', '17:30')),
    ]);
    expect(statuses(res)).toEqual([
      'APPLIED',
      'DUPLICATE',
      'APPLIED',
      'CONFLICT:ALREADY_COMPLETED',
    ]);
    const events = await ctx.prisma.attendanceEvent.findMany({
      where: { employeeId: staff.employeeId, status: 'ACCEPTED' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual(['TIME_IN', 'TIME_OUT']);
    expect(
      await ctx.prisma.attendanceDay.findFirstOrThrow({ where: { employeeId: staff.employeeId } }),
    ).toMatchObject({ hasOpenPunch: false, workedMinutes: 490 });
  });
});
