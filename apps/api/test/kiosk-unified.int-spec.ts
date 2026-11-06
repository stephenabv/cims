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

describe('Unified kiosk button (integration)', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.prisma.$disconnect();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetData(ctx.prisma);
    ctx.clock.set(manila('2026-11-04', '07:00'));
    const it = await createUser(ctx.prisma, { role: 'IT_ADMIN' });
    const c = new Client(ctx.app);
    await loginPrivileged(c, it, ctx.clock);
    token = (await c.post('/kiosk-devices', { name: 'Lobby tablet' })).body.token;
  });

  const kiosk = (path: string, body: object, t: string | undefined = token) =>
    new Client(ctx.app).kiosk(path, body, t);
  const identify = (user: Pick<TestUser, 'pin'>, accountNumber: string) =>
    kiosk('/kiosk/identify', { accountNumber, pin: user.pin });
  const confirm = (confirmationToken: string, t?: string) =>
    kiosk('/kiosk/confirm', { confirmationToken }, t);
  const press = async (user: TestUser) => {
    const id = await identify(user, user.accountNumber);
    expect(id.status).toBe(200);
    expect(id.body.status).toBe('READY');
    return { id: id.body, res: await confirm(id.body.confirmationToken) };
  };
  const events = (employeeId: string) =>
    ctx.prisma.attendanceEvent.findMany({ where: { employeeId }, orderBy: { occurredAt: 'asc' } });

  it('times in, then out, then reports the shift as complete', async () => {
    const staff = await createUser(ctx.prisma);

    ctx.clock.set(manila('2026-11-04', '07:55'));
    const first = await press(staff);
    expect(first.id).toMatchObject({ action: 'TIME_IN', workDate: '2026-11-04', timeInAt: null });
    expect(first.id.displayName).toMatch(/^Test U\.$/);
    expect(first.res.status).toBe(201);
    // The server's clock, not anything the kiosk sent.
    expect(first.res.body).toMatchObject({
      type: 'TIME_IN',
      occurredAt: manila('2026-11-04', '07:55').toISOString(),
    });

    ctx.clock.set(manila('2026-11-04', '17:05'));
    const second = await press(staff);
    expect(second.id).toMatchObject({
      action: 'TIME_OUT',
      timeInAt: manila('2026-11-04', '07:55').toISOString(),
    });
    expect(second.res.body.type).toBe('TIME_OUT');

    ctx.clock.set(manila('2026-11-04', '17:20'));
    const third = await identify(staff, staff.accountNumber);
    expect(third.body).toMatchObject({
      status: 'COMPLETED',
      workDate: '2026-11-04',
      timeOutAt: manila('2026-11-04', '17:05').toISOString(),
    });
    expect(third.body.confirmationToken).toBeUndefined();
    // The one-step endpoint follows the same rule.
    const legacy = await kiosk('/kiosk/punch', {
      accountNumber: staff.accountNumber,
      pin: staff.pin,
      type: 'TIME_IN',
    });
    expect(legacy.status).toBe(409);
    expect(legacy.body.error.details.reason).toBe('ALREADY_COMPLETED');

    expect((await events(staff.employeeId)).map((e) => e.type)).toEqual(['TIME_IN', 'TIME_OUT']);
    const audit = await ctx.prisma.auditLog.findMany({
      where: { action: 'attendance.punch.kiosk' },
    });
    expect(audit).toHaveLength(2);
    expect(audit[0]!.actorUserId).toBe(staff.userId);
  });

  it('reports an immediate second press as already recorded', async () => {
    const staff = await createUser(ctx.prisma);
    ctx.clock.set(manila('2026-11-04', '08:00'));
    await press(staff);
    ctx.clock.advance(15_000);
    const again = await identify(staff, staff.accountNumber);
    expect(again.body).toMatchObject({ status: 'JUST_RECORDED', type: 'TIME_IN' });
  });

  it('records one punch however often a confirmation is retried or clicked', async () => {
    const staff = await createUser(ctx.prisma);
    ctx.clock.set(manila('2026-11-04', '08:00'));
    const id = (await identify(staff, staff.accountNumber)).body;

    // Repeated clicks and a retry after a dropped response all return the same punch.
    const results = await Promise.all([1, 2, 3].map(() => confirm(id.confirmationToken)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.occurredAt)).size).toBe(1);
    ctx.clock.advance(5 * 60_000); // even after the token has expired
    const late = await confirm(id.confirmationToken);
    expect(late.status).toBe(201);
    expect(late.body.occurredAt).toBe(results[0]!.body.occurredAt);
    expect(await events(staff.employeeId)).toHaveLength(1);
  });

  it('lets only one of two simultaneous confirmations record the same action', async () => {
    const staff = await createUser(ctx.prisma);
    ctx.clock.set(manila('2026-11-04', '08:00'));
    const a = (await identify(staff, staff.accountNumber)).body;
    const b = (await identify(staff, staff.accountNumber)).body;
    expect([a.action, b.action]).toEqual(['TIME_IN', 'TIME_IN']);
    const results = await Promise.all([confirm(a.confirmationToken), confirm(b.confirmationToken)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.details.reason).toBe('DUPLICATE');
    expect(await events(staff.employeeId)).toHaveLength(1);
  });

  it('rejects expired, forged and other-device confirmations', async () => {
    const staff = await createUser(ctx.prisma);
    ctx.clock.set(manila('2026-11-04', '08:00'));
    const id = (await identify(staff, staff.accountNumber)).body;

    const it = await createUser(ctx.prisma, { role: 'IT_ADMIN' });
    const c = new Client(ctx.app);
    await loginPrivileged(c, it, ctx.clock);
    const other = (await c.post('/kiosk-devices', { name: 'Gate' })).body.token as string;
    const elsewhere = await confirm(id.confirmationToken, other);
    expect(elsewhere.body.error.details.reason).toBe('CONFIRMATION_INVALID');

    const forged = await confirm(`kc1.${'A'.repeat(40)}`);
    expect(forged.status).toBe(409);
    expect(forged.body.error.details.reason).toBe('CONFIRMATION_INVALID');

    ctx.clock.advance(2 * 60_000);
    const expired = await confirm(id.confirmationToken);
    expect(expired.body.error.details.reason).toBe('CONFIRMATION_EXPIRED');
    expect(await events(staff.employeeId)).toHaveLength(0);
  });

  it('refuses to record for an account suspended after identification', async () => {
    const staff = await createUser(ctx.prisma);
    const id = (await identify(staff, staff.accountNumber)).body;
    await ctx.prisma.userAccount.update({
      where: { id: staff.userId },
      data: { status: 'SUSPENDED' },
    });
    expect((await confirm(id.confirmationToken)).status).toBe(403);
  });

  it('keeps an overnight shift on the work date it started', async () => {
    const staff = await createUser(ctx.prisma);
    const night = await ctx.prisma.workSchedule.create({
      data: {
        name: 'Night shift',
        days: {
          create: [1, 2, 3, 4, 5].map((weekday) => ({
            weekday,
            startMinute: 22 * 60,
            endMinute: 30 * 60,
          })),
        },
      },
    });
    await ctx.prisma.employee.update({
      where: { id: staff.employeeId },
      data: { workScheduleId: night.id },
    });

    // Arrives late, after midnight: still Wednesday's shift.
    ctx.clock.set(manila('2026-11-05', '00:20'));
    const inn = await press(staff);
    expect(inn.res.body).toMatchObject({ type: 'TIME_IN', workDate: '2026-11-04' });

    ctx.clock.set(manila('2026-11-05', '06:10'));
    const out = await press(staff);
    expect(out.res.body).toMatchObject({ type: 'TIME_OUT', workDate: '2026-11-04' });

    ctx.clock.set(manila('2026-11-05', '06:30'));
    expect((await identify(staff, staff.accountNumber)).body.status).toBe('COMPLETED');

    ctx.clock.set(manila('2026-11-05', '21:50'));
    expect((await identify(staff, staff.accountNumber)).body).toMatchObject({
      status: 'READY',
      action: 'TIME_IN',
      workDate: '2026-11-05',
    });
    const day = await ctx.prisma.attendanceDay.findFirstOrThrow({
      where: { employeeId: staff.employeeId },
    });
    expect(day).toMatchObject({ status: 'LATE', lateMinutes: 140, hasOpenPunch: false });
  });

  describe('employee number input', () => {
    let one: TestUser;
    let other: TestUser;
    beforeEach(async () => {
      one = await createUser(ctx.prisma, { accountNumber: 'EMP-000001' });
      other = await createUser(ctx.prisma, { accountNumber: 'EMP-001025', lastName: 'Zamora' });
    });

    it.each(['1', '000001', 'EMP000001', 'EMP1', 'emp-1', '  EMP 000001  '])(
      'identifies EMP-000001 from %j',
      async (input) => {
        const res = await identify(one, input);
        expect(res.status).toBe(200);
        expect(res.body.displayName).toBe(`Test ${'U'}.`);
      },
    );

    it.each(['1025', 'EMP001025'])('identifies EMP-001025 from %j', async (input) => {
      const res = await identify(other, input);
      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe('Test Z.');
    });

    it('rejects malformed numbers and does not reveal which numbers exist', async () => {
      const malformed = await identify(one, '12a');
      expect(malformed.status).toBe(400);
      expect(JSON.stringify(malformed.body)).not.toMatch(/exist|not found/i);

      const unknown = await identify(one, '999');
      const wrongPin = await kiosk('/kiosk/identify', { accountNumber: '1', pin: '111222' });
      expect(unknown.status).toBe(401);
      expect(wrongPin.status).toBe(401);
      expect(unknown.body.error.message).toBe(wrongPin.body.error.message);
    });
  });
});
