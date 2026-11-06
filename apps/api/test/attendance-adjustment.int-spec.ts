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

describe('HR attendance adjustments (integration)', () => {
  let ctx: TestContext;
  let hr: Client;
  let hrUser: TestUser;
  let staff: TestUser;

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
    staff = await createUser(ctx.prisma);
    hrUser = await createUser(ctx.prisma, { role: 'HR' });
    hr = new Client(ctx.app);
    await loginPrivileged(hr, hrUser, ctx.clock);
  });

  const add = (c: Client, employeeId: string, body: Record<string, unknown>) =>
    c.post(`/attendance/employees/${employeeId}/punches`, body);
  const day = (workDate: string) =>
    ctx.prisma.attendanceDay.findFirst({
      where: { employeeId: staff.employeeId, workDate: new Date(`${workDate}T00:00:00Z`) },
    });

  it('adds missing punches with a reason, recomputes the day and audits it', async () => {
    const tin = await add(hr, staff.employeeId, {
      type: 'TIME_IN',
      date: '2026-11-04',
      time: '08:05',
      reason: 'Kiosk was down, confirmed by supervisor',
    });
    expect(tin.status).toBe(201);
    expect(tin.body.workDate).toBe('2026-11-04');
    expect(await day('2026-11-04')).toMatchObject({ hasOpenPunch: true });

    await add(hr, staff.employeeId, {
      type: 'TIME_OUT',
      date: '2026-11-04',
      time: '17:00',
      reason: 'Kiosk was down, confirmed by supervisor',
    });
    expect(await day('2026-11-04')).toMatchObject({
      status: 'PRESENT',
      lateMinutes: 0,
      hasOpenPunch: false,
    });

    const event = await ctx.prisma.attendanceEvent.findUniqueOrThrow({
      where: { id: tin.body.id },
    });
    expect(event).toMatchObject({
      source: 'ADJUSTMENT',
      status: 'ACCEPTED',
      createdById: hrUser.userId,
      note: 'Kiosk was down, confirmed by supervisor',
    });
    expect(event.occurredAt.getTime()).toBe(manila('2026-11-04', '08:05').getTime());
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'attendance.punch.add', actorUserId: hrUser.userId },
      }),
    ).toBe(2);

    // The employee sees the punch and HR's reason in their own history.
    const own = new Client(ctx.app);
    await own.login(staff);
    const res = await own.get('/attendance/me?from=2026-11-04&to=2026-11-04');
    expect(res.body.days[0].punches[0]).toMatchObject({
      source: 'ADJUSTMENT',
      note: 'Kiosk was down, confirmed by supervisor',
    });
  });

  it('puts an after-midnight time-out on the work date of its time-in', async () => {
    await add(hr, staff.employeeId, {
      type: 'TIME_IN',
      date: '2026-11-03',
      time: '22:00',
      reason: 'Night shift, forgot to punch',
    });
    const out = await add(hr, staff.employeeId, {
      type: 'TIME_OUT',
      date: '2026-11-04',
      time: '06:00',
      reason: 'Night shift, forgot to punch',
    });
    expect(out.body.workDate).toBe('2026-11-03');
    expect(await day('2026-11-03')).toMatchObject({ hasOpenPunch: false, workedMinutes: 420 });
  });

  it('validates input and refuses duplicates, the future and unknown employees', async () => {
    const base = { type: 'TIME_IN', date: '2026-11-04', time: '08:00', reason: 'Missed punch' };
    expect((await add(hr, staff.employeeId, { ...base, reason: '  ' })).status).toBe(400);
    expect((await add(hr, staff.employeeId, { ...base, time: '8am' })).status).toBe(400);
    const future = await add(hr, staff.employeeId, { ...base, date: '2026-11-05', time: '10:30' });
    expect(future.status).toBe(400);
    expect(future.body.error.details).toEqual([
      expect.objectContaining({ path: 'time', message: 'A punch cannot be in the future' }),
    ]);
    expect((await add(hr, staff.employeeId, base)).status).toBe(201);
    expect((await add(hr, staff.employeeId, { ...base, time: '08:00' })).status).toBe(409);
    expect((await add(hr, '00000000-0000-4000-8000-00000000dead', base)).status).toBe(404);
    expect(await ctx.prisma.attendanceEvent.count()).toBe(1);
  });

  it('voids a wrong punch once, keeps the original and recomputes the day', async () => {
    const tin = await add(hr, staff.employeeId, {
      type: 'TIME_IN',
      date: '2026-11-04',
      time: '08:00',
      reason: 'Missed punch',
    });
    const tout = await add(hr, staff.employeeId, {
      type: 'TIME_OUT',
      date: '2026-11-04',
      time: '12:00',
      reason: 'Missed punch',
    });
    expect(await day('2026-11-04')).toMatchObject({ hasOpenPunch: false });

    const voidIt = (id: string, reason: string) =>
      hr.post(`/attendance/punches/${id}/void`, { reason });
    expect((await voidIt(tout.body.id, '')).status).toBe(400);
    expect((await voidIt(tout.body.id, 'Wrong time, employee left at 17:00')).status).toBe(204);
    expect((await voidIt(tout.body.id, 'Again')).status).toBe(409);
    expect((await voidIt('00000000-0000-4000-8000-00000000dead', 'No such punch')).status).toBe(
      404,
    );

    expect(await day('2026-11-04')).toMatchObject({ hasOpenPunch: true });
    const voided = await ctx.prisma.attendanceEvent.findUniqueOrThrow({
      where: { id: tout.body.id },
    });
    expect(voided).toMatchObject({
      status: 'VOIDED',
      voidedById: hrUser.userId,
      voidReason: 'Wrong time, employee left at 17:00',
    });
    expect(await ctx.prisma.attendanceEvent.count()).toBe(2);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'attendance.punch.void', entityId: tout.body.id },
    });
    expect(audit.after).toMatchObject({
      status: 'VOIDED',
      type: 'TIME_OUT',
      workDate: '2026-11-04',
    });
    expect(tin.status).toBe(201);
  });

  it('allows only users with the adjust permission, and never on their own record', async () => {
    const body = { type: 'TIME_IN', date: '2026-11-04', time: '08:00', reason: 'Missed punch' };
    const staffClient = new Client(ctx.app);
    await staffClient.login(staff);
    expect((await add(staffClient, staff.employeeId, body)).status).toBe(403);

    const itUser = await createUser(ctx.prisma, { role: 'IT_ADMIN' });
    const it = new Client(ctx.app);
    await loginPrivileged(it, itUser, ctx.clock);
    expect((await add(it, staff.employeeId, body)).status).toBe(403);

    const self = await add(hr, hrUser.employeeId, body);
    expect(self.status).toBe(403);

    const other = await createUser(ctx.prisma, { role: 'HR' });
    const otherHr = new Client(ctx.app);
    await loginPrivileged(otherHr, other, ctx.clock);
    const punch = await add(otherHr, hrUser.employeeId, body);
    expect(punch.status).toBe(201);
    expect(
      (await hr.post(`/attendance/punches/${punch.body.id}/void`, { reason: 'Not mine to fix' }))
        .status,
    ).toBe(403);
    expect(await ctx.prisma.attendanceEvent.count()).toBe(1);
  });
});
