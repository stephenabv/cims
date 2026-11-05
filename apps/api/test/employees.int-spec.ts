import {
  Client,
  createTestApp,
  createUser,
  loginPrivileged,
  resetData,
  type TestContext,
  type TestUser,
} from './helpers';

describe('Employees & organisation (integration)', () => {
  let ctx: TestContext;
  let staffRoleId: string;
  let itRoleId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    staffRoleId = (await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'STAFF' } })).id;
    itRoleId = (await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'IT_ADMIN' } })).id;
  });
  afterAll(async () => {
    await ctx.prisma.$disconnect();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetData(ctx.prisma);
    ctx.mailer.sent.length = 0;
    ctx.clock.reset();
  });

  const client = () => new Client(ctx.app);
  const asPrivileged = async (
    role: 'HR' | 'IT_ADMIN' | 'EXECUTIVE',
  ): Promise<{ c: Client; user: TestUser }> => {
    const user = await createUser(ctx.prisma, { role });
    const c = client();
    await loginPrivileged(c, user);
    return { c, user };
  };
  const asStaff = async (): Promise<{ c: Client; user: TestUser }> => {
    const user = await createUser(ctx.prisma);
    const c = client();
    await c.login(user);
    return { c, user };
  };

  const provisionBody = (overrides: Record<string, unknown> = {}) => ({
    firstName: 'Maria',
    lastName: 'Reyes',
    companyEmail: 'Maria.Reyes@ACME.test',
    departmentId: null,
    positionId: null,
    supervisorId: null,
    classification: 'PROBATIONARY',
    dateHired: '2026-11-03',
    roleId: staffRoleId,
    ...overrides,
  });

  describe('provisioning', () => {
    it('creates an account, emails credentials, and forces a password change at first sign-in', async () => {
      const { c } = await asPrivileged('HR');
      const res = await c.post('/employees', provisionBody());
      expect(res.status).toBe(201);
      expect(res.body.credentialsDelivered).toBe(true);
      const emp = res.body.employee;
      expect(emp.accountNumber).toMatch(/^EMP-\d{6}$/);
      expect(emp.companyEmail).toBe('maria.reyes@acme.test');
      expect(emp.accountStatus).toBe('ACTIVE');
      expect(JSON.stringify(res.body)).not.toMatch(/password|pin/i);

      const mail = ctx.mailer.last();
      expect(mail.to).toBe('maria.reyes@acme.test');
      const temp = /^\s{4}(\S+)$/m.exec(mail.text)![1]!;
      expect(/Attendance PIN: (\d{6})/.exec(mail.text)).not.toBeNull();

      const newHire = client();
      const login = await newHire.login({ accountNumber: emp.accountNumber, password: temp });
      expect(login.status).toBe(200);
      expect(login.body.user.mustChangePassword).toBe(true);

      const history = await c.get(`/employees/${emp.id}/history`);
      expect(history.body[0]).toMatchObject({ field: 'record', newValue: 'created' });
    });

    it('assigns sequential, unique account numbers', async () => {
      const { c } = await asPrivileged('HR');
      const a = await c.post('/employees', provisionBody({ companyEmail: 'a@acme.test' }));
      const b = await c.post('/employees', provisionBody({ companyEmail: 'b@acme.test' }));
      const n = (s: string) => Number(s.slice(4));
      expect(n(b.body.employee.accountNumber)).toBe(n(a.body.employee.accountNumber) + 1);
    });

    it('can leave the account pending until activated', async () => {
      const { c } = await asPrivileged('HR');
      const res = await c.post('/employees', provisionBody({ activate: false }));
      expect(res.body.employee.accountStatus).toBe('PENDING_ACTIVATION');
      const act = await c.post(`/employees/${res.body.employee.id}/lifecycle/activate`, {
        reason: 'Documents verified',
      });
      expect(act.status).toBe(200);
      expect(act.body.accountStatus).toBe('ACTIVE');
    });

    it('rejects non-company email domains', async () => {
      const { c } = await asPrivileged('HR');
      const res = await c.post('/employees', provisionBody({ companyEmail: 'someone@gmail.com' }));
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('companyEmail');
    });

    it('rejects duplicate company emails', async () => {
      const { c } = await asPrivileged('HR');
      expect((await c.post('/employees', provisionBody())).status).toBe(201);
      expect((await c.post('/employees', provisionBody())).status).toBe(409);
    });

    it('only lets access administrators assign privileged roles', async () => {
      const hr = await asPrivileged('HR');
      expect((await hr.c.post('/employees', provisionBody({ roleId: itRoleId }))).status).toBe(403);
      const it = await asPrivileged('IT_ADMIN');
      expect((await it.c.post('/employees', provisionBody({ roleId: itRoleId }))).status).toBe(201);
    });

    it('lists only the roles the actor may assign', async () => {
      const hr = await asPrivileged('HR');
      expect(
        (await hr.c.get('/access/roles/assignable')).body.map((r: { key: string }) => r.key),
      ).toEqual(['STAFF']);
      const it = await asPrivileged('IT_ADMIN');
      expect((await it.c.get('/access/roles/assignable')).body).toHaveLength(5);
      const staff = await asStaff();
      expect((await staff.c.get('/access/roles/assignable')).status).toBe(403);
    });

    it('is forbidden for staff', async () => {
      const { c } = await asStaff();
      expect((await c.post('/employees', provisionBody())).status).toBe(403);
    });
  });

  describe('visibility', () => {
    it('limits staff to their own record and hides others as not found', async () => {
      const { c, user } = await asStaff();
      const other = await createUser(ctx.prisma);
      const list = await c.get('/employees');
      expect(list.body.meta.total).toBe(1);
      expect(list.body.data[0].id).toBe(user.employeeId);
      expect((await c.get(`/employees/${other.employeeId}`)).status).toBe(404);
      expect((await c.get(`/employees/${other.employeeId}/history`)).status).toBe(404);
      expect((await c.get('/employees/me')).body.id).toBe(user.employeeId);
    });

    it('limits executives to the departments they head', async () => {
      const exec = await asPrivileged('EXECUTIVE');
      const sales = await ctx.prisma.department.create({
        data: { code: 'SALES', name: 'Sales', headId: exec.user.employeeId },
      });
      const ops = await ctx.prisma.department.create({ data: { code: 'OPS', name: 'Operations' } });
      const inSales = await createUser(ctx.prisma);
      const inOps = await createUser(ctx.prisma);
      await ctx.prisma.employee.update({
        where: { id: inSales.employeeId },
        data: { departmentId: sales.id },
      });
      await ctx.prisma.employee.update({
        where: { id: inOps.employeeId },
        data: { departmentId: ops.id },
      });

      const list = await exec.c.get('/employees?pageSize=50');
      const ids = list.body.data.map((e: { id: string }) => e.id);
      expect(ids).toEqual(expect.arrayContaining([inSales.employeeId, exec.user.employeeId]));
      expect(ids).not.toContain(inOps.employeeId);
      expect((await exec.c.get(`/employees/${inOps.employeeId}`)).status).toBe(404);
    });

    it('lets HR search and paginate all employees', async () => {
      const { c } = await asPrivileged('HR');
      for (let i = 0; i < 3; i++) await createUser(ctx.prisma);
      const page = await c.get('/employees?page=1&pageSize=2');
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta.total).toBe(4);
      const search = await c.get(`/employees?search=${encodeURIComponent('user')}`);
      expect(search.body.meta.total).toBeGreaterThanOrEqual(3);
      expect((await c.get('/employees?pageSize=1000')).status).toBe(400);
    });
  });

  describe('updates', () => {
    it('lets employees edit their personal details and records the history', async () => {
      const { c, user } = await asStaff();
      const me = (await c.get('/employees/me')).body;
      const res = await c.send('patch', `/employees/${user.employeeId}/personal`, {
        version: me.version,
        contactNumber: '+63 917 555 0101',
        emergencyContactName: 'Jose Reyes',
      });
      expect(res.status).toBe(200);
      expect(res.body.contactNumber).toBe('+63 917 555 0101');
      expect(res.body.version).toBe(me.version + 1);
      const history = (await c.get(`/employees/${user.employeeId}/history`)).body.map(
        (h: { field: string }) => h.field,
      );
      expect(history).toEqual(expect.arrayContaining(['contactNumber', 'emergencyContactName']));
    });

    it('ignores attempts to smuggle restricted fields through the personal endpoint', async () => {
      const { c, user } = await asStaff();
      const me = (await c.get('/employees/me')).body;
      await c.send('patch', `/employees/${user.employeeId}/personal`, {
        version: me.version,
        contactNumber: '09170000000',
        classification: 'REGULAR',
        accountNumber: 'EMP-000999',
      });
      const after = (await c.get('/employees/me')).body;
      expect(after.classification).toBe(me.classification);
      expect(after.accountNumber).toBe(me.accountNumber);
    });

    it('blocks staff from editing employment details or other people', async () => {
      const { c, user } = await asStaff();
      const other = await createUser(ctx.prisma);
      expect(
        (
          await c.send('patch', `/employees/${user.employeeId}/employment`, {
            version: 1,
            classification: 'REGULAR',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await c.send('patch', `/employees/${other.employeeId}/personal`, {
            version: 1,
            contactNumber: '09170000000',
          })
        ).status,
      ).toBe(404);
    });

    it('detects concurrent edits with the version number', async () => {
      const { c } = await asPrivileged('HR');
      const target = await createUser(ctx.prisma);
      expect(
        (
          await c.send('patch', `/employees/${target.employeeId}/employment`, {
            version: 1,
            classification: 'REGULAR',
          })
        ).status,
      ).toBe(200);
      const stale = await c.send('patch', `/employees/${target.employeeId}/employment`, {
        version: 1,
        classification: 'CONTRACTUAL',
      });
      expect(stale.status).toBe(409);
    });

    it('rejects circular reporting lines', async () => {
      const { c } = await asPrivileged('HR');
      const a = await createUser(ctx.prisma);
      const b = await createUser(ctx.prisma);
      expect(
        (
          await c.send('patch', `/employees/${b.employeeId}/employment`, {
            version: 1,
            supervisorId: a.employeeId,
          })
        ).status,
      ).toBe(200);
      const history = (await c.get(`/employees/${b.employeeId}/history`)).body;
      expect(history[0]).toMatchObject({
        field: 'supervisorId',
        oldValue: null,
        newValue: expect.stringContaining(a.accountNumber),
      });
      const loop = await c.send('patch', `/employees/${a.employeeId}/employment`, {
        version: 1,
        supervisorId: b.employeeId,
      });
      expect(loop.status).toBe(400);
      expect(loop.body.error.details[0].path).toBe('supervisorId');
    });
  });

  describe('account lifecycle', () => {
    it('suspends (revoking sessions), then reactivates an account', async () => {
      const { c } = await asPrivileged('HR');
      const staff = await asStaff();
      const suspend = await c.post(`/employees/${staff.user.employeeId}/lifecycle/suspend`, {
        reason: 'Pending investigation',
      });
      expect(suspend.status).toBe(200);
      expect(suspend.body.accountStatus).toBe('SUSPENDED');
      expect((await staff.c.get('/auth/me')).status).toBe(401);
      expect((await client().login(staff.user)).body.error.code).toBe('ACCOUNT_INACTIVE');

      expect(
        (await c.post(`/employees/${staff.user.employeeId}/lifecycle/suspend`, { reason: 'again' }))
          .status,
      ).toBe(409);
      expect(
        (
          await c.post(`/employees/${staff.user.employeeId}/lifecycle/reactivate`, {
            reason: 'Cleared',
          })
        ).body.accountStatus,
      ).toBe('ACTIVE');
      expect((await client().login(staff.user)).status).toBe(200);
    });

    it('requires a reason and an allowed action', async () => {
      const { c } = await asPrivileged('HR');
      const staff = await createUser(ctx.prisma);
      expect((await c.post(`/employees/${staff.employeeId}/lifecycle/suspend`, {})).status).toBe(
        400,
      );
      expect(
        (await c.post(`/employees/${staff.employeeId}/lifecycle/delete`, { reason: 'nope' }))
          .status,
      ).toBe(400);
    });

    it('prevents acting on your own account or on access administrators without access rights', async () => {
      const hr = await asPrivileged('HR');
      expect(
        (await hr.c.post(`/employees/${hr.user.employeeId}/lifecycle/suspend`, { reason: 'self' }))
          .status,
      ).toBe(403);
      const it = await createUser(ctx.prisma, { role: 'IT_ADMIN' });
      expect(
        (await hr.c.post(`/employees/${it.employeeId}/lifecycle/deactivate`, { reason: 'test' }))
          .status,
      ).toBe(403);
    });

    it('changes roles with a reason, revoking the target’s sessions', async () => {
      const { c } = await asPrivileged('IT_ADMIN');
      const staff = await asStaff();
      const hrRole = await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'HR' } });
      const res = await c.post(`/employees/${staff.user.employeeId}/role`, {
        roleId: hrRole.id,
        reason: 'Transferred to HR',
      });
      expect(res.status).toBe(200);
      expect(res.body.role.key).toBe('HR');
      expect((await staff.c.get('/auth/me')).status).toBe(401);
    });

    it('stops HR from promoting someone to a privileged role', async () => {
      const { c } = await asPrivileged('HR');
      const staff = await createUser(ctx.prisma);
      const res = await c.post(`/employees/${staff.employeeId}/role`, {
        roleId: itRoleId,
        reason: 'Escalation attempt',
      });
      expect(res.status).toBe(403);
    });
  });

  describe('organisation', () => {
    it('lets HR manage departments and positions, and everyone read them', async () => {
      const { c, user } = await asPrivileged('HR');
      const dept = await c.post('/org/departments', {
        code: 'fin',
        name: 'Finance',
        headId: user.employeeId,
      });
      expect(dept.status).toBe(201);
      expect(dept.body.code).toBe('FIN');
      const pos = await c.post('/org/positions', {
        title: 'Accountant',
        departmentId: dept.body.id,
      });
      expect(pos.status).toBe(201);
      expect((await c.post('/org/departments', { code: 'FIN', name: 'Finance 2' })).status).toBe(
        409,
      );

      const staff = await asStaff();
      expect((await staff.c.get('/org/departments')).body[0]).toMatchObject({
        name: 'Finance',
        head: { id: user.employeeId },
      });
      expect((await staff.c.post('/org/departments', { code: 'X1', name: 'X' })).status).toBe(403);
    });
  });
});
