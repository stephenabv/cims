import {
  Client,
  createTestApp,
  createUser,
  loginPrivileged,
  resetData,
  type TestContext,
  type TestUser,
} from './helpers';

/** 2026-11-05 is a Thursday; 2026-11-09 … 13 is Monday to Friday. Asia/Manila (UTC+8). */
const manila = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);

describe('Leave (integration)', () => {
  let ctx: TestContext;
  let staff: TestUser;
  let sup: TestUser;
  let hrUser: TestUser;
  let staffC: Client;
  let supC: Client;
  let hr: Client;
  let vl: string;

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
    vl = (await ctx.prisma.leaveType.findUniqueOrThrow({ where: { code: 'VL' } })).id;
  });

  const apply = (c: Client, body: Record<string, unknown> = {}) =>
    c.post('/leave/requests', {
      leaveTypeId: vl,
      startDate: '2026-11-09',
      endDate: '2026-11-13',
      reason: 'Family trip',
      ...body,
    });
  const decide = (c: Client, r: { id: string; version: number }, decision: string, note?: string) =>
    c.post(`/leave/requests/${r.id}/decide`, { decision, note, version: r.version });

  it('runs a request through supervisor then HR and shows it as leave in attendance', async () => {
    await ctx.prisma.holiday.create({
      data: { date: new Date('2026-11-11T00:00:00Z'), name: 'Company day' },
    });
    const preview = await staffC.post('/leave/preview', {
      leaveTypeId: vl,
      startDate: '2026-11-07',
      endDate: '2026-11-13',
    });
    expect(preview.body).toEqual({
      days: 4,
      dates: ['2026-11-09', '2026-11-10', '2026-11-12', '2026-11-13'],
    });

    const filed = await apply(staffC, { startDate: '2026-11-07' });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({
      status: 'PENDING',
      days: 4,
      version: 1,
      can: { decide: false, withdraw: true, cancel: false },
    });
    expect(filed.body.steps).toEqual([
      expect.objectContaining({
        kind: 'SUPERVISOR',
        status: 'PENDING',
        approver: expect.stringMatching(/^Test User/),
      }),
      expect.objectContaining({ kind: 'ROLE', status: 'WAITING', approver: 'Human Resources' }),
    ]);

    // Only the current step's approver sees it in their queue.
    expect((await supC.get('/leave/requests/approvals')).body.meta.total).toBe(1);
    expect((await hr.get('/leave/requests/approvals')).body.meta.total).toBe(0);
    expect((await staffC.get('/leave/requests/approvals')).body.meta.total).toBe(0);
    expect((await decide(hr, filed.body, 'APPROVE')).status).toBe(403);

    const first = await decide(supC, filed.body, 'APPROVE', 'Enjoy');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'PENDING', version: 2 });
    // A second click with the old version is refused instead of acting twice.
    expect((await decide(supC, filed.body, 'APPROVE')).status).toBe(409);
    expect(
      (await staffC.post(`/leave/requests/${filed.body.id}/withdraw`, { version: 2 })).status,
    ).toBe(409);

    const hrQueue = await hr.get('/leave/requests/approvals');
    expect(hrQueue.body.data[0].can.decide).toBe(true);
    const final = await decide(hr, first.body, 'APPROVE');
    expect(final.body).toMatchObject({ status: 'APPROVED', version: 3 });
    expect(final.body.steps.map((s: { status: string }) => s.status)).toEqual([
      'APPROVED',
      'APPROVED',
    ]);
    expect(final.body.steps[0]).toMatchObject({
      note: 'Enjoy',
      actedBy: expect.stringMatching(/^Test User/),
    });

    ctx.clock.set(manila('2026-11-16', '10:00'));
    await staffC.login(staff); // the earlier session has idled out by then
    const att = await staffC.get('/attendance/me?from=2026-11-09&to=2026-11-13');
    expect(
      att.body.days.map((d: { workDate: string; status: string }) => `${d.workDate}:${d.status}`),
    ).toEqual([
      '2026-11-13:ON_LEAVE',
      '2026-11-12:ON_LEAVE',
      '2026-11-11:HOLIDAY',
      '2026-11-10:ON_LEAVE',
      '2026-11-09:ON_LEAVE',
    ]);
    expect(att.body.summary).toMatchObject({ absences: 0, leaveDays: 4 });

    const balances = await staffC.get('/leave/balances/me/2026');
    expect(
      balances.body.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'VL'),
    ).toMatchObject({
      allottedDays: null,
      approvedDays: 4,
      pendingDays: 0,
      remainingDays: null,
    });
    const actions = await ctx.prisma.auditLog.findMany({
      where: { entityId: filed.body.id },
      orderBy: { id: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual([
      'leave.request.submit',
      'leave.request.approve_step',
      'leave.request.approve_step',
    ]);
  });

  it('rejects overlaps, empty ranges and allows refiling after a withdrawal', async () => {
    const filed = await apply(staffC);
    const overlap = await apply(staffC, { startDate: '2026-11-13', endDate: '2026-11-16' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.message).toContain('2026-11-09 to 2026-11-13');

    const weekend = await apply(staffC, { startDate: '2026-11-07', endDate: '2026-11-08' });
    expect(weekend.status).toBe(400);
    expect(weekend.body.error.details).toEqual([
      expect.objectContaining({
        path: 'endDate',
        message: 'There are no working days in this range',
      }),
    ]);
    expect((await apply(staffC, { startDate: '2026-11-10', endDate: '2026-11-09' })).status).toBe(
      400,
    );
    expect((await apply(staffC, { reason: '' })).status).toBe(400);
    await ctx.prisma.employee.update({
      where: { id: staff.employeeId },
      data: { dateHired: new Date('2026-11-02') },
    });
    const beforeHire = await apply(staffC, { startDate: '2026-10-30', endDate: '2026-11-03' });
    expect(beforeHire.status).toBe(400);
    expect(beforeHire.body.error.details).toEqual([
      expect.objectContaining({
        path: 'startDate',
        message: 'Leave cannot start before your hire date',
      }),
    ]);

    const withdrawn = await staffC.post(`/leave/requests/${filed.body.id}/withdraw`, {
      version: 1,
    });
    expect(withdrawn.body).toMatchObject({ status: 'WITHDRAWN' });
    expect(withdrawn.body.steps.map((s: { status: string }) => s.status)).toEqual([
      'CANCELLED',
      'CANCELLED',
    ]);
    expect((await apply(staffC)).status).toBe(201);

    // Two overlapping submissions at once: exactly one is accepted.
    await ctx.prisma.leaveRequest.updateMany({ data: { status: 'WITHDRAWN' } });
    const both = await Promise.all([
      apply(staffC, { startDate: '2026-11-16', endDate: '2026-11-17' }),
      apply(staffC, { startDate: '2026-11-17', endDate: '2026-11-18' }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('requires a reason to reject and shows it to the employee', async () => {
    const filed = await apply(staffC);
    expect((await decide(supC, filed.body, 'REJECT')).status).toBe(400);
    const rejected = await decide(supC, filed.body, 'REJECT', 'Team is short that week');
    expect(rejected.body).toMatchObject({ status: 'REJECTED' });
    const mine = await staffC.get('/leave/requests/mine');
    expect(mine.body.data[0].steps).toEqual([
      expect.objectContaining({ status: 'REJECTED', note: 'Team is short that week' }),
      expect.objectContaining({ status: 'CANCELLED' }),
    ]);
  });

  it('skips a missing supervisor, never self-approves, and hides requests from outsiders', async () => {
    // HR applying with no supervisor: the HR step remains, but only another HR user can act.
    const own = await apply(hr);
    expect(own.body.steps).toEqual([
      expect.objectContaining({
        kind: 'SUPERVISOR',
        status: 'SKIPPED',
        note: 'No supervisor assigned',
      }),
      expect.objectContaining({ kind: 'ROLE', status: 'PENDING' }),
    ]);
    expect(own.body.can.decide).toBe(false);
    expect((await decide(hr, own.body, 'APPROVE')).status).toBe(403);
    const otherHrUser = await createUser(ctx.prisma, { role: 'HR' });
    const otherHr = new Client(ctx.app);
    await loginPrivileged(otherHr, otherHrUser, ctx.clock);
    expect((await decide(otherHr, own.body, 'APPROVE')).body.status).toBe('APPROVED');

    const filed = await apply(staffC);
    const outsider = await createUser(ctx.prisma);
    const outC = new Client(ctx.app);
    await outC.login(outsider);
    expect((await outC.get(`/leave/requests/${filed.body.id}`)).status).toBe(404);
    expect((await decide(outC, filed.body, 'APPROVE')).status).toBe(404);
    expect((await outC.get('/leave/requests')).status).toBe(403);
    expect((await hr.get('/leave/requests')).body.meta.total).toBe(2);
  });

  it('enforces an allotment when HR sets one, per calendar year', async () => {
    expect(
      (
        await hr.put('/leave/config/balances', {
          employeeId: staff.employeeId,
          leaveTypeId: vl,
          year: 2026,
          allottedDays: 3,
        })
      ).status,
    ).toBe(204);
    const over = await apply(staffC);
    expect(over.status).toBe(400);
    expect(over.body.error.details[0].message).toBe(
      'Only 3 day(s) of Vacation leave left for 2026; this request needs 5',
    );
    expect((await apply(staffC, { endDate: '2026-11-11' })).status).toBe(201);
    const [b] = (await staffC.get('/leave/balances/me/2026')).body.filter(
      (x: { leaveType: { code: string } }) => x.leaveType.code === 'VL',
    );
    expect(b).toMatchObject({ allottedDays: 3, pendingDays: 3, remainingDays: 0 });

    // A request across New Year only counts this year's days against this year's allotment.
    expect((await apply(staffC, { startDate: '2026-12-31', endDate: '2027-01-04' })).status).toBe(
      400,
    );
    await hr.put('/leave/config/balances', {
      employeeId: staff.employeeId,
      leaveTypeId: vl,
      year: 2026,
      allottedDays: null,
    });
    expect((await apply(staffC, { startDate: '2026-12-31', endDate: '2027-01-04' })).status).toBe(
      201,
    );
    expect((await staffC.put('/leave/config/balances', {})).status).toBe(403);
  });

  it('lets HR cancel approved leave only before it starts', async () => {
    const approve = async (startDate: string, endDate: string) => {
      const filed = await apply(staffC, { startDate, endDate });
      const a = await decide(supC, filed.body, 'APPROVE');
      return (await decide(hr, a.body, 'APPROVE')).body as { id: string; version: number };
    };
    const started = await approve('2026-11-05', '2026-11-06');
    const future = await approve('2026-11-09', '2026-11-13');
    const cancel = (c: Client, r: { id: string; version: number }) =>
      c.post(`/leave/requests/${r.id}/cancel`, { version: r.version, reason: 'Needed on site' });

    expect((await cancel(staffC, future)).status).toBe(403);
    expect((await cancel(hr, started)).status).toBe(409);
    const cancelled = await cancel(hr, future);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', endReason: 'Needed on site' });
    expect((await cancel(hr, future)).status).toBe(409);
    await expect(ctx.prisma.leaveRequest.deleteMany()).rejects.toThrow();
  });

  it('uses a leave type’s own chain, resolved when the request is filed', async () => {
    const bad = await hr.post('/leave/config/chains', { name: 'Bad', steps: [{ kind: 'ROLE' }] });
    expect(bad.status).toBe(400);
    const chain = await hr.post('/leave/config/chains', {
      name: 'Department head only',
      steps: [{ kind: 'EMPLOYEE', employeeId: sup.employeeId }],
    });
    expect(chain.status).toBe(201);
    const type = await hr.post('/leave/config/types', {
      code: 'bday',
      name: 'Birthday leave',
      isPaid: true,
      approvalChainId: chain.body.id,
    });
    expect(type.body).toMatchObject({ code: 'BDAY', isActive: true });
    expect(
      (await hr.post('/leave/config/types', { code: 'BDAY', name: 'Other', isPaid: false })).status,
    ).toBe(409);
    expect(
      (await staffC.post('/leave/config/types', { code: 'X', name: 'Xx', isPaid: false })).status,
    ).toBe(403);

    const filed = await apply(staffC, {
      leaveTypeId: type.body.id,
      startDate: '2026-11-09',
      endDate: '2026-11-09',
    });
    expect(filed.body.steps).toEqual([
      expect.objectContaining({ kind: 'EMPLOYEE', status: 'PENDING' }),
    ]);
    expect((await decide(supC, filed.body, 'APPROVE')).body.status).toBe('APPROVED');

    await hr.put(`/leave/config/types/${type.body.id}`, {
      code: 'BDAY',
      name: 'Birthday leave',
      isPaid: true,
      isActive: false,
    });
    const inactive = await apply(staffC, {
      leaveTypeId: type.body.id,
      startDate: '2026-11-16',
      endDate: '2026-11-16',
    });
    expect(inactive.status).toBe(400);
    expect(
      (await staffC.get('/leave/types')).body.map((t: { code: string }) => t.code),
    ).not.toContain('BDAY');
  });
});
