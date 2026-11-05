import {
  Client,
  createTestApp,
  createUser,
  loginPrivileged,
  resetData,
  type TestContext,
  type TestUser,
} from './helpers';

/** Instants in Asia/Manila (UTC+8, no DST). 2026-11-04 is a Wednesday. */
const manila = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);

describe('Attendance kiosk & monitoring (integration)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.prisma.$disconnect();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetData(ctx.prisma);
    ctx.clock.reset();
  });

  const client = () => new Client(ctx.app);
  const asPrivileged = async (
    role: 'HR' | 'IT_ADMIN' | 'EXECUTIVE' | 'CEO',
  ): Promise<{ c: Client; user: TestUser }> => {
    const user = await createUser(ctx.prisma, { role });
    const c = client();
    await loginPrivileged(c, user, ctx.clock);
    return { c, user };
  };
  const registerDevice = async (): Promise<string> => {
    const { c } = await asPrivileged('IT_ADMIN');
    const res = await c.post('/kiosk-devices', { name: 'Lobby tablet' });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^kio_/);
    return res.body.token as string;
  };
  const punch = (
    user: Pick<TestUser, 'accountNumber' | 'pin'>,
    type: 'TIME_IN' | 'TIME_OUT',
    token?: string,
  ) =>
    client().kiosk(
      '/kiosk/punch',
      { accountNumber: user.accountNumber, pin: user.pin, type },
      token,
    );

  describe('kiosk punching', () => {
    it('records time in and time out on a registered device, rejecting duplicates and out-of-order punches', async () => {
      ctx.clock.set(manila('2026-11-04', '07:50'));
      const token = await registerDevice();
      const staff = await createUser(ctx.prisma);

      const status = await client().kiosk('/kiosk/status', undefined, token);
      expect(status.body).toMatchObject({
        device: { name: 'Lobby tablet' },
        acceptsPunches: true,
        timezone: 'Asia/Manila',
      });

      expect((await punch(staff, 'TIME_OUT', token)).body.error.details.reason).toBe(
        'NOT_TIMED_IN',
      );

      ctx.clock.set(manila('2026-11-04', '08:30'));
      const timeIn = await punch(staff, 'TIME_IN', token);
      expect(timeIn.status).toBe(201);
      expect(timeIn.body).toMatchObject({ type: 'TIME_IN', workDate: '2026-11-04' });
      expect(timeIn.body.displayName).toMatch(/^Test U\.$/);

      const dup = await punch(staff, 'TIME_IN', token);
      expect(dup.status).toBe(409);
      expect(dup.body.error.details.reason).toBe('DUPLICATE');

      ctx.clock.set(manila('2026-11-04', '09:00'));
      expect((await punch(staff, 'TIME_IN', token)).body.error.details.reason).toBe(
        'ALREADY_TIMED_IN',
      );

      ctx.clock.set(manila('2026-11-04', '17:00'));
      const out = await punch(staff, 'TIME_OUT', token);
      expect(out.status).toBe(201);
      expect(out.body.workDate).toBe('2026-11-04');
      expect((await punch(staff, 'TIME_OUT', token)).body.error.details.reason).toBe('DUPLICATE');

      const day = await ctx.prisma.attendanceDay.findFirstOrThrow({
        where: { employeeId: staff.employeeId },
      });
      expect(day).toMatchObject({
        status: 'LATE',
        lateMinutes: 30,
        workedMinutes: 450,
        hasOpenPunch: false,
      });
      const device = await ctx.prisma.kioskDevice.findFirstOrThrow();
      expect(device.tokenHash).not.toContain(token);
      expect(
        await ctx.prisma.attendanceEvent.count({
          where: { deviceId: device.id, source: 'KIOSK_ONLINE' },
        }),
      ).toBe(2);
    });

    it('rejects unregistered and revoked devices unless the company allows unregistered kiosks', async () => {
      const staff = await createUser(ctx.prisma);
      const none = await punch(staff, 'TIME_IN');
      expect(none.status).toBe(401);
      expect((await client().kiosk('/kiosk/status')).body).toMatchObject({
        device: null,
        acceptsPunches: false,
      });

      const { c } = await asPrivileged('IT_ADMIN');
      const reg = await c.post('/kiosk-devices', { name: 'Gate kiosk' });
      expect((await c.post(`/kiosk-devices/${reg.body.id}/revoke`)).status).toBe(204);
      expect((await punch(staff, 'TIME_IN', reg.body.token)).status).toBe(401);
      expect((await punch(staff, 'TIME_IN', 'kio_forged')).status).toBe(401);

      await ctx.prisma.companySetting.create({
        data: { key: 'attendance.allowUnregisteredDevices', value: true },
      });
      expect((await punch(staff, 'TIME_IN')).status).toBe(201);
    });

    it('only lets kiosk managers register devices', async () => {
      const { c } = await asPrivileged('HR');
      expect((await c.post('/kiosk-devices', { name: 'Rogue' })).status).toBe(403);
      expect((await client().get('/kiosk-devices')).status).toBe(401);
    });

    it('locks the PIN after repeated failures without revealing whether the account exists', async () => {
      await ctx.prisma.companySetting.create({
        data: { key: 'attendance.allowUnregisteredDevices', value: true },
      });
      const staff = await createUser(ctx.prisma);
      const unknown = await punch({ accountNumber: 'EMP-999998', pin: '482915' }, 'TIME_IN');
      expect(unknown.status).toBe(401);

      let last = unknown;
      for (let i = 0; i < 5; i += 1) last = await punch({ ...staff, pin: '111222' }, 'TIME_IN');
      expect(last.status).toBe(401);
      expect(last.body.error.message).toBe(unknown.body.error.message);

      const locked = await punch(staff, 'TIME_IN');
      expect(locked.status).toBe(423);
      expect(await ctx.prisma.attendanceEvent.count()).toBe(0);

      ctx.clock.advance(16 * 60_000);
      expect((await punch(staff, 'TIME_IN')).status).toBe(201);
      const account = await ctx.prisma.userAccount.findUniqueOrThrow({
        where: { id: staff.userId },
      });
      expect(account).toMatchObject({ failedPinCount: 0, pinLockedUntil: null });
    });

    it('refuses suspended accounts after verifying the PIN', async () => {
      await ctx.prisma.companySetting.create({
        data: { key: 'attendance.allowUnregisteredDevices', value: true },
      });
      const suspended = await createUser(ctx.prisma, { status: 'SUSPENDED' });
      const res = await punch(suspended, 'TIME_IN');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
      const wrongPin = await punch({ ...suspended, pin: '000111' }, 'TIME_IN');
      expect(wrongPin.status).toBe(401);
    });

    it('serialises concurrent punches by the same person', async () => {
      await ctx.prisma.companySetting.create({
        data: { key: 'attendance.allowUnregisteredDevices', value: true },
      });
      const staff = await createUser(ctx.prisma);
      const results = await Promise.all([
        punch(staff, 'TIME_IN'),
        punch(staff, 'TIME_IN'),
        punch(staff, 'TIME_IN'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(await ctx.prisma.attendanceEvent.count()).toBe(1);
    });
  });

  describe('viewing attendance', () => {
    /** Staff punches late on Wednesday; the queries then run on Thursday morning. */
    async function wednesdayScenario() {
      await ctx.prisma.companySetting.create({
        data: { key: 'attendance.allowUnregisteredDevices', value: true },
      });
      const staff = await createUser(ctx.prisma);
      ctx.clock.set(manila('2026-11-04', '08:30'));
      await punch(staff, 'TIME_IN');
      ctx.clock.set(manila('2026-11-04', '17:00'));
      await punch(staff, 'TIME_OUT');
      ctx.clock.set(manila('2026-11-05', '10:00'));
      return staff;
    }

    it('shows an employee their own days, deriving absences, holidays and today', async () => {
      const staff = await wednesdayScenario();
      const { c: hr } = await asPrivileged('HR');
      expect(
        (await hr.post('/holidays', { date: '2026-11-03', name: 'Company anniversary' })).status,
      ).toBe(201);
      expect((await hr.post('/holidays', { date: '2026-11-03', name: 'Duplicate' })).status).toBe(
        409,
      );

      const me = client();
      await me.login(staff);
      const res = await me.get('/attendance/me?from=2026-11-02&to=2026-11-08');
      expect(res.status).toBe(200);
      expect(
        res.body.days.map((d: { workDate: string; status: string }) => [d.workDate, d.status]),
      ).toEqual([
        ['2026-11-05', 'NOT_YET_IN'],
        ['2026-11-04', 'LATE'],
        ['2026-11-03', 'HOLIDAY'],
        ['2026-11-02', 'ABSENT'],
      ]);
      expect(res.body.summary).toMatchObject({
        daysWorked: 1,
        absences: 1,
        lateCount: 1,
        totalLateMinutes: 30,
        totalWorkedMinutes: 450,
      });
      expect(res.body.days[1].punches).toHaveLength(2);

      expect((await me.get('/attendance/me?from=2026-11-08&to=2026-11-02')).status).toBe(400);
      expect((await me.get('/attendance/me?from=2026-01-01&to=2026-11-02')).status).toBe(400);
    });

    it('limits other people’s attendance to the viewer’s scope', async () => {
      const staff = await wednesdayScenario();
      const other = await createUser(ctx.prisma);
      const { c: exec, user: execUser } = await asPrivileged('EXECUTIVE');
      const dept = await ctx.prisma.department.create({
        data: { code: 'OPS', name: 'Operations', headId: execUser.employeeId },
      });
      await ctx.prisma.employee.update({
        where: { id: staff.employeeId },
        data: { departmentId: dept.id },
      });

      expect(
        (await exec.get(`/attendance/employees/${staff.employeeId}?from=2026-11-04&to=2026-11-04`))
          .status,
      ).toBe(200);
      expect(
        (await exec.get(`/attendance/employees/${other.employeeId}?from=2026-11-04&to=2026-11-04`))
          .status,
      ).toBe(404);

      const monitor = await exec.get('/attendance/monitor?date=2026-11-04');
      expect(monitor.status).toBe(200);
      expect(monitor.body.rows.map((r: { employee: { id: string } }) => r.employee.id)).toEqual([
        staff.employeeId,
      ]);

      const peer = client();
      await peer.login(other);
      expect(
        (await peer.get(`/attendance/employees/${staff.employeeId}?from=2026-11-04&to=2026-11-04`))
          .status,
      ).toBe(403);
      expect((await peer.get('/attendance/monitor?date=2026-11-04')).status).toBe(403);
    });

    it('gives HR a company-wide board with status counts, filters and pagination', async () => {
      const staff = await wednesdayScenario();
      await createUser(ctx.prisma, { status: 'SUSPENDED' });
      const { c: hr } = await asPrivileged('HR');

      const res = await hr.get('/attendance/monitor?date=2026-11-04');
      expect(res.status).toBe(200);
      // Active accounts: staff (late) and the HR user (absent). Suspended accounts are excluded.
      expect(res.body.counts).toEqual({ LATE: 1, ABSENT: 1 });
      expect(res.body.meta.total).toBe(2);
      const late = res.body.rows.find((r: { status: string }) => r.status === 'LATE');
      expect(late).toMatchObject({ employee: { id: staff.employeeId }, lateMinutes: 30 });
      expect(late.firstIn).toBe(manila('2026-11-04', '08:30').toISOString());

      const filtered = await hr.get('/attendance/monitor?date=2026-11-04&status=ABSENT&pageSize=1');
      expect(filtered.body.rows).toHaveLength(1);
      expect(filtered.body.rows[0].status).toBe('ABSENT');
      expect(filtered.body.counts).toEqual({ LATE: 1, ABSENT: 1 });

      const today = await hr.get('/attendance/monitor?date=2026-11-05');
      expect(today.body.counts).toEqual({ NOT_YET_IN: 2 });
    });
  });

  describe('schedules', () => {
    it('lets HR create and assign schedules, which change how days are classified', async () => {
      const staff = await staffOnThursdayMorning();
      const { c: hr } = await asPrivileged('HR');
      const created = await hr.post('/schedules', {
        name: 'Weekend crew',
        graceMinutes: 10,
        breakMinutes: 60,
        breakThresholdMinutes: 240,
        days: [
          { weekday: 6, startMinute: 480, endMinute: 1020 },
          { weekday: 7, startMinute: 480, endMinute: 1020 },
        ],
      });
      expect(created.status).toBe(201);
      expect(
        (
          await hr.send('put', `/employees/${staff.employeeId}/schedule`, {
            scheduleId: created.body.id,
          })
        ).status,
      ).toBe(204);

      const view = await hr.get(
        `/attendance/employees/${staff.employeeId}?from=2026-11-02&to=2026-11-03`,
      );
      expect(view.body.days.map((d: { status: string }) => d.status)).toEqual([
        'REST_DAY',
        'REST_DAY',
      ]);
      const history = await ctx.prisma.employeeChangeHistory.findFirstOrThrow({
        where: { employeeId: staff.employeeId, field: 'workSchedule' },
      });
      expect(history.newValue).toBe(created.body.id);

      const invalid = await hr.post('/schedules', {
        name: 'Bad',
        graceMinutes: 0,
        breakMinutes: 0,
        breakThresholdMinutes: 0,
        days: [{ weekday: 1, startMinute: 600, endMinute: 500 }],
      });
      expect(invalid.status).toBe(400);
    });

    it('blocks staff from managing schedules and holidays', async () => {
      const staff = await createUser(ctx.prisma);
      const c = client();
      await c.login(staff);
      expect((await c.get('/schedules')).status).toBe(403);
      expect(
        (await c.post('/holidays', { date: '2026-12-25', name: 'Christmas Day' })).status,
      ).toBe(403);
      expect((await c.get('/holidays/2026')).status).toBe(200);
    });

    async function staffOnThursdayMorning(): Promise<TestUser> {
      const staff = await createUser(ctx.prisma);
      ctx.clock.set(manila('2026-11-05', '10:00'));
      return staff;
    }
  });
});
