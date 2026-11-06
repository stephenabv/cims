import {
  Client,
  createTestApp,
  createUser,
  loginPrivileged,
  resetData,
  type TestContext,
  type TestUser,
} from './helpers';

/** Asia/Manila (UTC+8). 2026-11-04 is a Wednesday. */
const manila = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);

describe('Attendance correction requests (integration)', () => {
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
  });

  /** Seeds punches on Wednesday 2026-11-04 directly (as the kiosk would have). */
  async function punches(...list: [type: 'TIME_IN' | 'TIME_OUT', time: string][]) {
    const ids: string[] = [];
    for (const [type, time] of list) {
      const e = await ctx.prisma.attendanceEvent.create({
        data: {
          employeeId: staff.employeeId,
          type,
          occurredAt: manila('2026-11-04', time),
          workDate: new Date('2026-11-04T00:00:00Z'),
          source: 'KIOSK_ONLINE',
        },
      });
      ids.push(e.id);
    }
    return ids;
  }
  const file = (c: Client, body: Record<string, unknown>) =>
    c.post('/attendance/corrections', {
      workDate: '2026-11-04',
      reason: 'The kiosk was frozen when I arrived',
      ...body,
    });
  const decide = (
    c: Client,
    r: { id: string; version: number },
    decision: 'APPROVE' | 'REJECT',
    note?: string,
  ) => c.post(`/attendance/corrections/${r.id}/decision`, { decision, note, version: r.version });
  const accepted = () =>
    ctx.prisma.attendanceEvent.findMany({
      where: { employeeId: staff.employeeId, status: 'ACCEPTED' },
      orderBy: { occurredAt: 'asc' },
    });

  it('changes a time in after supervisor and HR approve, keeping the original on record', async () => {
    const [timeIn] = await punches(['TIME_IN', '09:10'], ['TIME_OUT', '17:05']);

    const filed = await file(staffC, {
      type: 'CHANGE_TIME_IN',
      targetEventId: timeIn,
      requestedDate: '2026-11-04',
      requestedTime: '07:58',
    });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({
      status: 'PENDING',
      punchType: 'TIME_IN',
      originalAt: manila('2026-11-04', '09:10').toISOString(),
      requestedAt: manila('2026-11-04', '07:58').toISOString(),
      can: { decide: false, cancel: true },
    });
    expect(filed.body.steps.map((s: { status: string }) => s.status)).toEqual([
      'PENDING',
      'WAITING',
    ]);
    // The supervisor is told there is something to review.
    expect(await ctx.prisma.notification.count({ where: { userId: sup.userId } })).toBe(1);

    // HR cannot act before the supervisor; the employee cannot act at all.
    expect((await decide(hr, filed.body, 'APPROVE')).status).toBe(403);
    expect((await decide(staffC, filed.body, 'APPROVE')).status).toBe(403);

    const queue = await supC.get('/attendance/corrections/approvals');
    expect(queue.body.data).toHaveLength(1);
    // Side by side: the request and the record as it stands.
    expect(queue.body.data[0].currentPunches.map((p: { type: string }) => p.type)).toEqual([
      'TIME_IN',
      'TIME_OUT',
    ]);
    const step1 = await decide(supC, filed.body, 'APPROVE', 'I saw her arrive');
    expect(step1.status).toBe(200);
    expect(step1.body.status).toBe('PENDING');
    expect(await accepted()).toHaveLength(2); // nothing applied until the final step

    const final = await decide(hr, step1.body, 'APPROVE');
    expect(final.status).toBe(200);
    expect(final.body).toMatchObject({
      status: 'APPROVED',
      appliedAt: manila('2026-11-04', '07:58').toISOString(),
      originalAt: manila('2026-11-04', '09:10').toISOString(),
      decidedBy: expect.stringMatching(/^Test User/),
    });

    const now = await accepted();
    expect(now.map((e) => [e.type, e.source, e.occurredAt.toISOString()])).toEqual([
      ['TIME_IN', 'ADJUSTMENT', manila('2026-11-04', '07:58').toISOString()],
      ['TIME_OUT', 'KIOSK_ONLINE', manila('2026-11-04', '17:05').toISOString()],
    ]);
    const original = await ctx.prisma.attendanceEvent.findUniqueOrThrow({ where: { id: timeIn } });
    expect(original).toMatchObject({ status: 'VOIDED' });
    expect(original.voidReason).toContain('Correction request');
    const day = await ctx.prisma.attendanceDay.findFirstOrThrow({
      where: { employeeId: staff.employeeId },
    });
    expect(day).toMatchObject({ status: 'PRESENT', lateMinutes: 0 });

    const audit = await ctx.prisma.auditLog.findMany({
      where: { entityType: 'attendance_correction_request' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'attendance.correction.submit',
      'attendance.correction.approve_step',
      'attendance.correction.approve',
    ]);
    expect(audit[2]!.before).toMatchObject({
      originalAt: manila('2026-11-04', '09:10').toISOString(),
    });
    expect(audit[2]!.after).toMatchObject({
      appliedAt: manila('2026-11-04', '07:58').toISOString(),
    });

    const notices = await staffC.get('/notifications');
    expect(notices.body.unread).toBe(1);
    expect(notices.body.data[0]).toMatchObject({ title: 'Attendance correction approved' });
    expect(ctx.mailer.sent.some((m) => m.to === staff.email)).toBe(true);
    // The request itself can never be deleted.
    await expect(ctx.prisma.attendanceCorrectionRequest.deleteMany()).rejects.toThrow();
  });

  it('adds a missing time out and changes a time out', async () => {
    await punches(['TIME_IN', '08:00']);
    const missing = await file(staffC, {
      type: 'MISSING_TIME_OUT',
      requestedDate: '2026-11-04',
      requestedTime: '17:00',
    });
    expect(missing.status).toBe(201);
    const s1 = await decide(supC, missing.body, 'APPROVE');
    await decide(hr, s1.body, 'APPROVE');
    const after = await accepted();
    expect(after.map((e) => e.type)).toEqual(['TIME_IN', 'TIME_OUT']);

    const out = await file(staffC, {
      type: 'CHANGE_TIME_OUT',
      targetEventId: after[1]!.id,
      requestedDate: '2026-11-04',
      requestedTime: '18:30',
      reason: 'I stayed late for the inventory count',
    });
    expect(out.status).toBe(201);
    expect(out.body.originalAt).toBe(manila('2026-11-04', '17:00').toISOString());
  });

  it('validates the request against the record', async () => {
    const [timeIn] = await punches(['TIME_IN', '08:00']);
    const noReason = await file(staffC, {
      type: 'MISSING_TIME_OUT',
      requestedDate: '2026-11-04',
      requestedTime: '17:00',
      reason: '',
    });
    expect(noReason.status).toBe(400);
    expect(JSON.stringify(noReason.body)).toMatch(/Explain the correction/);

    expect(
      (
        await file(staffC, {
          type: 'MISSING_TIME_IN',
          requestedDate: '2026-11-04',
          requestedTime: '07:50',
        })
      ).status,
    ).toBe(400); // already has a time in
    expect(
      (
        await file(staffC, {
          type: 'CHANGE_TIME_OUT',
          targetEventId: timeIn,
          requestedDate: '2026-11-04',
          requestedTime: '17:00',
        })
      ).status,
    ).toBe(400); // target is a time in
    expect(
      (
        await file(staffC, {
          type: 'MISSING_TIME_OUT',
          requestedDate: '2026-11-04',
          requestedTime: '07:00',
        })
      ).status,
    ).toBe(400); // out before in
    expect(
      (
        await file(staffC, {
          type: 'MISSING_TIME_OUT',
          requestedDate: '2026-11-05',
          requestedTime: '11:00',
        })
      ).status,
    ).toBe(400); // in the future
    expect((await file(staffC, { type: 'CHANGE_TIME_IN' })).status).toBe(400); // no target / time

    const ok = { type: 'MISSING_TIME_OUT', requestedDate: '2026-11-04', requestedTime: '17:00' };
    expect((await file(staffC, ok)).status).toBe(201);
    expect((await file(staffC, ok)).status).toBe(409); // one pending request of a kind per day
  });

  it('never lets an employee correct someone else’s punches', async () => {
    const [timeIn] = await punches(['TIME_IN', '08:30']);
    const other = await createUser(ctx.prisma);
    const otherC = new Client(ctx.app);
    await otherC.login(other);
    const res = await file(otherC, {
      type: 'CHANGE_TIME_IN',
      targetEventId: timeIn,
      requestedDate: '2026-11-04',
      requestedTime: '08:00',
    });
    expect(res.status).toBe(400);
    expect(await ctx.prisma.attendanceCorrectionRequest.count()).toBe(0);

    // Nor see or act on a request that is not theirs.
    const mine = await file(staffC, {
      type: 'CHANGE_TIME_IN',
      targetEventId: timeIn,
      requestedDate: '2026-11-04',
      requestedTime: '08:00',
    });
    expect((await otherC.get(`/attendance/corrections/${mine.body.id}`)).status).toBe(404);
    expect((await decide(otherC, mine.body, 'APPROVE')).status).toBe(404);
    expect(
      (await otherC.post(`/attendance/corrections/${mine.body.id}/cancel`, { version: 1 })).status,
    ).toBe(404);
  });

  it('requires a reason to reject, and keeps rejected requests for reference', async () => {
    await punches(['TIME_IN', '08:00']);
    const filed = await file(staffC, {
      type: 'MISSING_TIME_OUT',
      requestedDate: '2026-11-04',
      requestedTime: '17:00',
    });
    expect((await decide(supC, filed.body, 'REJECT')).status).toBe(400);
    const rejected = await decide(supC, filed.body, 'REJECT', 'You left at noon that day');
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      decisionNote: 'You left at noon that day',
      appliedAt: null,
    });
    expect(await accepted()).toHaveLength(1);
    const history = await staffC.get('/attendance/corrections/mine?status=REJECTED');
    expect(history.body.data).toHaveLength(1);
    const notices = await staffC.get('/notifications');
    expect(notices.body.data[0].body).toMatch(/You left at noon that day/);
  });

  it('lets the employee cancel before anyone acts, and stops self-approval for approvers', async () => {
    await punches(['TIME_IN', '08:00']);
    const filed = await file(staffC, {
      type: 'MISSING_TIME_OUT',
      requestedDate: '2026-11-04',
      requestedTime: '17:00',
    });
    const cancelled = await staffC.post(`/attendance/corrections/${filed.body.id}/cancel`, {
      version: filed.body.version,
    });
    expect(cancelled.body.status).toBe('CANCELLED');

    // An HR user filing their own request: HR is the chain's role step, but never for themselves.
    await ctx.prisma.attendanceEvent.create({
      data: {
        employeeId: hrUser.employeeId,
        type: 'TIME_IN',
        occurredAt: manila('2026-11-04', '08:00'),
        workDate: new Date('2026-11-04T00:00:00Z'),
        source: 'KIOSK_ONLINE',
      },
    });
    const own = await hr.post('/attendance/corrections', {
      workDate: '2026-11-04',
      type: 'MISSING_TIME_OUT',
      requestedDate: '2026-11-04',
      requestedTime: '17:00',
      reason: 'Forgot to tap out at the kiosk',
    });
    expect(own.status).toBe(201);
    expect(own.body.can.decide).toBe(false);
    expect((await decide(hr, own.body, 'APPROVE')).status).toBe(403);
    expect((await hr.get('/attendance/corrections/approvals')).body.data).toHaveLength(0);
  });

  it('records the decision for an "other" request without changing punches', async () => {
    await punches(['TIME_IN', '08:00'], ['TIME_OUT', '17:00']);
    const filed = await file(staffC, {
      type: 'OTHER',
      reason: 'I was on an approved field visit that afternoon; please mark it',
    });
    expect(filed.status).toBe(201);
    const s1 = await decide(supC, filed.body, 'APPROVE');
    const done = await decide(hr, s1.body, 'APPROVE', 'Will update manually');
    expect(done.body).toMatchObject({ status: 'APPROVED', appliedAt: null });
    expect(await accepted()).toHaveLength(2);
  });
});
