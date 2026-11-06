import {
  Client,
  createTestApp,
  createUser,
  loginPrivileged,
  resetData,
  type TestContext,
  type TestUser,
} from './helpers';

/**
 * Default schedule Mon–Fri 08:00–17:00 (60-min break), Asia/Manila. 2026-11-02 … 06 is Monday to
 * Friday; "today" is Friday 2026-11-06.
 */
const manila = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);
const REASON = 'Kiosk was down, confirmed by supervisor';

describe('Overtime (integration)', () => {
  let ctx: TestContext;
  let staff: TestUser;
  let sup: TestUser;
  let hrUser: TestUser;
  let staffC: Client;
  let supC: Client;
  let hr: Client;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.prisma.$disconnect();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetData(ctx.prisma);
    ctx.clock.set(manila('2026-11-06', '10:00'));
    sup = await createUser(ctx.prisma);
    staff = await createUser(ctx.prisma);
    hrUser = await createUser(ctx.prisma, { role: 'HR' });
    await ctx.prisma.employee.update({
      where: { id: staff.employeeId },
      data: { supervisorId: sup.employeeId },
    });
    staffC = new Client(ctx.app);
    await staffC.login(staff);
    supC = new Client(ctx.app);
    await supC.login(sup);
    hr = new Client(ctx.app);
    await loginPrivileged(hr, hrUser, ctx.clock);
  });

  /** HR records a day's punches for the staff member (adjustments recompute attendance). */
  const work = async (date: string, inAt: string, outAt: string) => {
    const employeeId = staff.employeeId;
    const tin = await hr.post(`/attendance/employees/${employeeId}/punches`, {
      type: 'TIME_IN',
      date,
      time: inAt,
      reason: REASON,
    });
    const tout = await hr.post(`/attendance/employees/${employeeId}/punches`, {
      type: 'TIME_OUT',
      date,
      time: outAt,
      reason: REASON,
    });
    expect([tin.status, tout.status]).toEqual([201, 201]);
    return { timeIn: tin.body.id as string, timeOut: tout.body.id as string };
  };
  const record = (date: string) =>
    ctx.prisma.overtimeRecord.findUnique({
      where: {
        employeeId_workDate: {
          employeeId: staff.employeeId,
          workDate: new Date(`${date}T00:00:00Z`),
        },
      },
    });

  it('creates a pending record that the supervisor approves in part, with history and audit', async () => {
    await work('2026-11-04', '08:00', '18:30');
    expect(await record('2026-11-04')).toMatchObject({ status: 'PENDING', actualMinutes: 90 });

    const mine = await staffC.get('/overtime/mine?from=2026-11-01&to=2026-11-30');
    expect(mine.body.data).toEqual([
      expect.objectContaining({
        workDate: '2026-11-04',
        actualMinutes: 90,
        can: { decide: false },
      }),
    ]);
    const id: string = mine.body.data[0].id;
    // Nobody decides their own overtime.
    expect(
      (await staffC.post(`/overtime/${id}/decide`, { decision: 'APPROVE', version: 1 })).status,
    ).toBe(404);

    expect((await supC.get('/overtime/waiting')).body).toEqual({ count: 1 });
    const list = await supC.get('/overtime?status=PENDING');
    expect(list.body.data).toEqual([
      expect.objectContaining({ id, can: { decide: true }, firstIn: expect.any(String) }),
    ]);

    const decide = (body: Record<string, unknown>) => supC.post(`/overtime/${id}/decide`, body);
    expect((await decide({ decision: 'APPROVE', approvedMinutes: 120, version: 1 })).status).toBe(
      400,
    );
    const partialNoNote = await decide({ decision: 'APPROVE', approvedMinutes: 60, version: 1 });
    expect(partialNoNote.status).toBe(400);
    expect(partialNoNote.body.error.details[0].path).toBe('note');

    const ok = await decide({
      decision: 'APPROVE',
      approvedMinutes: 60,
      note: 'Only the first hour was requested',
      version: 1,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'APPROVED',
      approvedMinutes: 60,
      version: 2,
      history: [
        expect.objectContaining({
          action: 'APPROVE',
          minutes: 60,
          actedBy: expect.stringContaining('Test'),
        }),
      ],
    });
    // A second decision on the old version is refused.
    expect(
      (await hr.post(`/overtime/${id}/decide`, { decision: 'REJECT', note: 'No', version: 1 }))
        .status,
    ).toBe(400);
    expect(
      (
        await hr.post(`/overtime/${id}/decide`, {
          decision: 'REJECT',
          note: 'Not needed',
          version: 1,
        })
      ).status,
    ).toBe(409);
    expect((await supC.get('/overtime/waiting')).body).toEqual({ count: 0 });
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'overtime.approve', entityId: id, actorUserId: sup.userId },
      }),
    ).toBe(1);
  });

  it('reopens a decision when attendance changes and voids it when overtime disappears', async () => {
    const { timeOut } = await work('2026-11-04', '08:00', '18:00');
    const id = (await record('2026-11-04'))!.id;
    await hr.post(`/overtime/${id}/decide`, { decision: 'APPROVE', version: 1 });
    expect(await record('2026-11-04')).toMatchObject({ status: 'APPROVED', approvedMinutes: 60 });

    // HR corrects the time-out to 19:00: the approval no longer matches what was worked.
    await hr.post(`/attendance/punches/${timeOut}/void`, { reason: 'Wrong time-out recorded' });
    expect(await record('2026-11-04')).toMatchObject({ status: 'VOIDED', approvedMinutes: null });
    const later = await hr.post(`/attendance/employees/${staff.employeeId}/punches`, {
      type: 'TIME_OUT',
      date: '2026-11-04',
      time: '19:00',
      reason: REASON,
    });
    expect(later.status).toBe(201);
    expect(await record('2026-11-04')).toMatchObject({
      status: 'PENDING',
      actualMinutes: 120,
      approvedMinutes: null,
    });

    const view = await supC.get(`/overtime/${id}`);
    expect(view.body.history.map((h: { action: string }) => h.action)).toEqual([
      'APPROVE',
      'VOID',
      'REOPEN',
    ]);
    expect(view.body.history[1].actedBy).toBeNull();

    // Undecided records without history are simply removed when their overtime goes away.
    const second = await work('2026-11-05', '08:00', '18:00');
    await hr.post(`/attendance/punches/${second.timeOut}/void`, {
      reason: 'Wrong time-out recorded',
    });
    expect(await record('2026-11-05')).toBeNull();
  });

  it('applies the company minimum, and only payroll configurers may change it', async () => {
    await work('2026-11-03', '08:00', '17:20');
    expect(await record('2026-11-03')).toBeNull();

    const policy = { overtimeMinimumMinutes: 15, undertimeThresholdMinutes: 30 };
    expect((await hr.put('/overtime/policy', policy)).status).toBe(403);
    const ceoUser = await createUser(ctx.prisma, { role: 'CEO' });
    const ceo = new Client(ctx.app);
    await loginPrivileged(ceo, ceoUser, ctx.clock);
    expect(
      (await ceo.put('/overtime/policy', { ...policy, overtimeMinimumMinutes: -1 })).status,
    ).toBe(400);
    const saved = await ceo.put('/overtime/policy', policy);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual(policy);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'settings.update', actorUserId: ceoUser.userId },
      }),
    ).toBe(2);

    // Applies to attendance recomputed from now on.
    await work('2026-11-04', '08:00', '17:20');
    expect(await record('2026-11-04')).toMatchObject({ actualMinutes: 20 });
    expect(await record('2026-11-03')).toBeNull();
  });

  it('limits visibility and decisions to the supervisor and permission scope', async () => {
    await work('2026-11-04', '08:00', '18:00');
    const id = (await record('2026-11-04'))!.id;

    const outsider = new Client(ctx.app);
    await outsider.login(await createUser(ctx.prisma));
    expect((await outsider.get(`/overtime/${id}`)).status).toBe(404);
    expect((await outsider.get('/overtime')).body.data).toEqual([]);
    expect(
      (await outsider.post(`/overtime/${id}/decide`, { decision: 'APPROVE', version: 1 })).status,
    ).toBe(404);
    expect(
      (await outsider.get('/overtime/summary?from=2026-11-01&to=2026-11-30')).body.data,
    ).toEqual([]);

    // HR approves anyone's overtime (view all + approve); rejecting needs a reason.
    expect(
      (await hr.post(`/overtime/${id}/decide`, { decision: 'REJECT', version: 1 })).status,
    ).toBe(400);
    const rejected = await hr.post(`/overtime/${id}/decide`, {
      decision: 'REJECT',
      note: 'Not pre-approved',
      version: 1,
    });
    expect(rejected.body).toMatchObject({ status: 'REJECTED', approvedMinutes: null });

    // HR's own overtime is visible to HR in "mine" but never decidable by them.
    // (HR cannot correct their own punches, so the record is created directly.)
    await ctx.prisma.overtimeRecord.create({
      data: {
        employeeId: hrUser.employeeId,
        workDate: new Date('2026-11-04T00:00:00Z'),
        actualMinutes: 60,
      },
    });
    const own = await hr.get('/overtime/mine?from=2026-11-04&to=2026-11-04');
    expect(own.body.data[0].can.decide).toBe(false);
    expect((await hr.get('/overtime?status=PENDING')).body.data).toEqual([]);
  });

  it('summarises overtime and undertime per employee for a day or a month', async () => {
    await ctx.prisma.companySetting.create({
      data: { key: 'undertime.thresholdMinutes', value: 30 },
    });
    await work('2026-11-02', '08:00', '19:00'); // 120 min overtime
    await work('2026-11-03', '08:00', '17:10'); // 10 min overtime, below the minimum
    await work('2026-11-04', '08:00', '16:40'); // 20 min undertime, below the threshold
    await work('2026-11-05', '08:30', '16:00'); // 30 min late, 60 min undertime
    const id = (await record('2026-11-02'))!.id;
    await supC.post(`/overtime/${id}/decide`, {
      decision: 'APPROVE',
      approvedMinutes: 90,
      note: 'Last 30 minutes were not needed',
      version: 1,
    });

    const month = await supC.get('/overtime/summary?from=2026-11-01&to=2026-11-30');
    expect(month.status).toBe(200);
    expect(month.body.data).toEqual([
      {
        employee: expect.objectContaining({ id: staff.employeeId }),
        daysWorked: 4,
        overtime: {
          approvedMinutes: 90,
          pendingMinutes: 0,
          rejectedMinutes: 0,
          unrecordedMinutes: 10,
        },
        undertime: { days: 2, totalMinutes: 80, countedMinutes: 60 },
        lateMinutes: 30,
      },
    ]);
    expect(month.body.totals).toEqual({
      approvedMinutes: 90,
      pendingMinutes: 0,
      undertimeCountedMinutes: 60,
      lateMinutes: 30,
    });
    expect(month.body.policy).toEqual({
      overtimeMinimumMinutes: 30,
      undertimeThresholdMinutes: 30,
    });

    const day = await hr.get('/overtime/summary?from=2026-11-04&to=2026-11-04');
    expect(day.body.data).toEqual([
      expect.objectContaining({
        daysWorked: 1,
        undertime: { days: 1, totalMinutes: 20, countedMinutes: 0 },
      }),
    ]);
    expect((await hr.get('/overtime/summary?from=2026-11-30&to=2026-11-01')).status).toBe(400);
    expect((await hr.get('/overtime/summary?from=2026-01-01&to=2026-12-31')).status).toBe(400);
  });
});
