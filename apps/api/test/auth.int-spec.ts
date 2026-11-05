import { authenticator } from 'otplib';
import { Client, createTestApp, createUser, resetData, type TestContext } from './helpers';

describe('Authentication & access control (integration)', () => {
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
    ctx.mailer.sent.length = 0;
    ctx.clock.reset();
  });

  const client = () => new Client(ctx.app);

  describe('CSRF', () => {
    it('rejects state-changing requests without a valid token', async () => {
      const user = await createUser(ctx.prisma);
      const res = await client().post(
        '/auth/login',
        { accountNumber: user.accountNumber, password: user.password },
        { csrf: false },
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_INVALID');
    });

    it('rejects a forged (unsigned) token even when cookie and header match', async () => {
      const user = await createUser(ctx.prisma);
      const res = await (await import('supertest'))
        .default(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Cookie', 'cims_csrf=abc.def')
        .set('X-CSRF-Token', 'abc.def')
        .send({ accountNumber: user.accountNumber, password: user.password });
      expect(res.status).toBe(403);
    });
  });

  describe('login', () => {
    it('authenticates a staff user and exposes /auth/me', async () => {
      const user = await createUser(ctx.prisma);
      const c = client();
      const res = await c.login(user);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('AUTHENTICATED');
      expect(res.body.user.accountNumber).toBe(user.accountNumber);
      expect(c.cookie('cims_session')).toBeDefined();

      const me = await c.get('/auth/me');
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({
        accountNumber: user.accountNumber,
        role: { key: 'STAFF' },
        mfaRequired: false,
      });
      expect(JSON.stringify(me.body)).not.toMatch(/hash/i);
    });

    it('normalises account number case', async () => {
      const user = await createUser(ctx.prisma);
      const res = await client().login({
        accountNumber: user.accountNumber.toLowerCase(),
        password: user.password,
      });
      expect(res.status).toBe(200);
    });

    it('returns the same error for unknown accounts and wrong passwords', async () => {
      const user = await createUser(ctx.prisma);
      const wrong = await client().login({
        accountNumber: user.accountNumber,
        password: 'Wrong-Password-1',
      });
      const unknown = await client().login({
        accountNumber: 'EMP-123456',
        password: 'Wrong-Password-1',
      });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(unknown.body.error.message).toBe(wrong.body.error.message);
    });

    it('locks the account after 5 failures and unlocks after the lockout window', async () => {
      const user = await createUser(ctx.prisma);
      for (let i = 0; i < 5; i++) {
        expect(
          (
            await client().login({
              accountNumber: user.accountNumber,
              password: 'Wrong-Password-1',
            })
          ).status,
        ).toBe(401);
      }
      const locked = await client().login(user);
      expect(locked.status).toBe(423);
      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');

      ctx.clock.advance(16 * 60_000);
      expect((await client().login(user)).status).toBe(200);

      const events = await ctx.prisma.authEvent.findMany({
        where: { userId: user.userId, type: 'ACCOUNT_LOCKED' },
      });
      expect(events).toHaveLength(1);
    });

    it.each(['SUSPENDED', 'DEACTIVATED', 'PENDING_ACTIVATION'] as const)(
      'refuses %s accounts',
      async (status) => {
        const user = await createUser(ctx.prisma, { status });
        const res = await client().login(user);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
      },
    );

    it('rejects an expired temporary password', async () => {
      const user = await createUser(ctx.prisma, {
        mustChangePassword: true,
        tempPasswordExpiresAt: new Date(Date.now() - 1000),
      });
      const res = await client().login(user);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TEMP_PASSWORD_EXPIRED');
    });

    it('rejects malformed input with a validation error', async () => {
      const res = await client().post('/auth/login', { accountNumber: 'nope', password: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('sessions', () => {
    it('requires a session for protected routes', async () => {
      expect((await client().get('/auth/me')).status).toBe(401);
    });

    it('revokes the session on logout', async () => {
      const user = await createUser(ctx.prisma);
      const c = client();
      await c.login(user);
      const token = c.cookie('cims_session')!;
      expect((await c.post('/auth/logout')).status).toBe(204);
      const replay = new Client(ctx.app);
      (replay as unknown as { cookies: Map<string, string> }).cookies.set('cims_session', token);
      expect((await replay.get('/auth/me')).status).toBe(401);
    });

    it('expires idle sessions', async () => {
      const user = await createUser(ctx.prisma);
      const c = client();
      await c.login(user);
      ctx.clock.advance(31 * 60_000);
      expect((await c.get('/auth/me')).status).toBe(401);
    });

    it('invalidates sessions when the account is suspended', async () => {
      const user = await createUser(ctx.prisma);
      const c = client();
      await c.login(user);
      await ctx.prisma.userAccount.update({
        where: { id: user.userId },
        data: { status: 'SUSPENDED' },
      });
      expect((await c.get('/auth/me')).status).toBe(401);
    });
  });

  describe('forced password change', () => {
    it('only allows /me and password change until the password is replaced', async () => {
      const user = await createUser(ctx.prisma, {
        mustChangePassword: true,
        tempPasswordExpiresAt: new Date(Date.now() + 3_600_000),
      });
      const c = client();
      expect((await c.login(user)).status).toBe(200);
      expect((await c.get('/auth/me')).body.mustChangePassword).toBe(true);
      const blocked = await c.post('/auth/pin', {
        currentPassword: user.password,
        newPin: '135790',
      });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

      const weak = await c.post('/auth/password', {
        currentPassword: user.password,
        newPassword: 'short',
      });
      expect(weak.status).toBe(400);
      expect(
        (
          await c.post('/auth/password', {
            currentPassword: user.password,
            newPassword: 'Brand-New-Passw0rd',
          })
        ).status,
      ).toBe(204);
      expect(
        (await c.post('/auth/pin', { currentPassword: 'Brand-New-Passw0rd', newPin: '135790' }))
          .status,
      ).toBe(204);
    });

    it('signs out other sessions on password change', async () => {
      const user = await createUser(ctx.prisma);
      const a = client();
      const b = client();
      await a.login(user);
      await b.login(user);
      expect(
        (
          await a.post('/auth/password', {
            currentPassword: user.password,
            newPassword: 'Brand-New-Passw0rd',
          })
        ).status,
      ).toBe(204);
      expect((await a.get('/auth/me')).status).toBe(200);
      expect((await b.get('/auth/me')).status).toBe(401);
    });
  });

  describe('two-factor authentication', () => {
    async function enrol(c: Client): Promise<{ secret: string; recoveryCodes: string[] }> {
      const start = await c.post('/auth/mfa/enroll');
      expect(start.status).toBe(200);
      const secret = start.body.secret as string;
      const confirm = await c.post('/auth/mfa/enroll/confirm', {
        code: authenticator.generate(secret),
      });
      expect(confirm.status).toBe(200);
      return { secret, recoveryCodes: confirm.body.recoveryCodes };
    }

    it('forces enrolment for privileged roles and blocks other routes until done', async () => {
      const hr = await createUser(ctx.prisma, { role: 'HR' });
      const c = client();
      const login = await c.login(hr);
      expect(login.body).toEqual({ status: 'MFA_ENROLLMENT_REQUIRED' });
      const me = await c.get('/auth/me');
      expect(me.status).toBe(401);
      expect(me.body.error.code).toBe('MFA_REQUIRED');

      const { recoveryCodes } = await enrol(c);
      expect(recoveryCodes).toHaveLength(10);
      expect((await c.get('/auth/me')).body.mfaEnabled).toBe(true);
    });

    it('requires a TOTP code on subsequent logins, rejects replays and bad codes', async () => {
      const hr = await createUser(ctx.prisma, { role: 'HR' });
      const first = client();
      await first.login(hr);
      const { secret } = await enrol(first);

      const c = client();
      expect((await c.login(hr)).body).toEqual({ status: 'MFA_REQUIRED' });
      const pendingToken = c.cookie('cims_session');
      expect((await c.post('/auth/mfa/verify', { code: '000000' })).status).toBe(401);

      // The code used during enrolment is in the same time-step: replay must fail.
      expect(
        (await c.post('/auth/mfa/verify', { code: authenticator.generate(secret) })).status,
      ).toBe(401);

      ctx.clock.advance(30_000);
      const code = authenticator.clone({ epoch: Date.now() + 30_000 }).generate(secret);
      const ok = await c.post('/auth/mfa/verify', { code });
      expect(ok.status).toBe(200);
      // Session is rotated after the privilege change.
      expect(c.cookie('cims_session')).not.toBe(pendingToken);
      expect((await c.get('/auth/me')).status).toBe(200);
    });

    it('accepts each recovery code once', async () => {
      const hr = await createUser(ctx.prisma, { role: 'HR' });
      const first = client();
      await first.login(hr);
      const { recoveryCodes } = await enrol(first);

      const c1 = client();
      await c1.login(hr);
      expect((await c1.post('/auth/mfa/verify', { code: recoveryCodes[0] })).status).toBe(200);

      const c2 = client();
      await c2.login(hr);
      expect((await c2.post('/auth/mfa/verify', { code: recoveryCodes[0] })).status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('denies routes when the role lacks the permission', async () => {
      const staff = await createUser(ctx.prisma);
      const c = client();
      await c.login(staff);
      const res = await c.get('/access/roles');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('lets IT manage roles after MFA', async () => {
      const it = await createUser(ctx.prisma, { role: 'IT_ADMIN' });
      const c = client();
      await c.login(it);
      const start = await c.post('/auth/mfa/enroll');
      await c.post('/auth/mfa/enroll/confirm', { code: authenticator.generate(start.body.secret) });
      const roles = await c.get('/access/roles');
      expect(roles.status).toBe(200);
      expect(roles.body.map((r: { key: string }) => r.key)).toEqual(
        expect.arrayContaining(['CEO', 'HR', 'STAFF']),
      );

      const created = await c.post('/access/roles', {
        key: 'team_lead',
        name: 'Team Lead',
        permissions: ['leave.approve'],
      });
      expect(created.status).toBe(201);
      expect(created.body.key).toBe('TEAM_LEAD');

      const bad = await c.post('/access/roles', {
        key: 'X_ROLE',
        name: 'X',
        permissions: ['not.a.permission'],
      });
      expect(bad.status).toBe(400);
    });
  });

  describe('administrative credential resets', () => {
    async function itClient(): Promise<Client> {
      const it = await createUser(ctx.prisma, { role: 'IT_ADMIN' });
      const c = client();
      await c.login(it);
      const start = await c.post('/auth/mfa/enroll');
      await c.post('/auth/mfa/enroll/confirm', { code: authenticator.generate(start.body.secret) });
      return c;
    }

    it('emails a temporary password (never returns it), revokes sessions and forces a change', async () => {
      const staff = await createUser(ctx.prisma);
      const staffClient = client();
      await staffClient.login(staff);
      const admin = await itClient();

      const res = await admin.post(`/accounts/${staff.userId}/temporary-password`);
      expect(res.status).toBe(202);
      expect(JSON.stringify(res.body)).not.toMatch(/password":/);
      expect((await staffClient.get('/auth/me')).status).toBe(401);

      const mail = ctx.mailer.last();
      expect(mail.to).toBe(staff.email);
      const temp = /^\s{4}(\S+)$/m.exec(mail.text)![1]!;
      const c = client();
      expect((await c.login({ accountNumber: staff.accountNumber, password: temp })).status).toBe(
        200,
      );
      expect((await c.get('/auth/me')).body.mustChangePassword).toBe(true);

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: 'account.temporary_password_issued', entityId: staff.userId },
      });
      expect(audit).not.toBeNull();
      expect(JSON.stringify({ ...audit, id: String(audit!.id) })).not.toContain(temp);
    });

    it('rejects staff calling admin credential endpoints', async () => {
      const staff = await createUser(ctx.prisma);
      const other = await createUser(ctx.prisma);
      const c = client();
      await c.login(staff);
      expect((await c.post(`/accounts/${other.userId}/temporary-password`)).status).toBe(403);
    });
  });

  describe('password recovery', () => {
    it('responds identically for unknown accounts and sends a single-use link for real ones', async () => {
      const user = await createUser(ctx.prisma);
      const unknown = await client().post('/auth/password-recovery', {
        accountNumber: 'EMP-777777',
      });
      const known = await client().post('/auth/password-recovery', {
        accountNumber: user.accountNumber,
      });
      expect(unknown.status).toBe(202);
      expect(known.status).toBe(202);
      expect(unknown.body).toEqual(known.body);
      expect(ctx.mailer.sent).toHaveLength(1);

      const token = decodeURIComponent(/token=([^\s]+)/.exec(ctx.mailer.last().text)![1]!);
      expect(
        (
          await client().post('/auth/password-recovery/complete', {
            token,
            newPassword: 'Recovered-Passw0rd',
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await client().post('/auth/password-recovery/complete', {
            token,
            newPassword: 'Another-Passw0rd1',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await client().login({
            accountNumber: user.accountNumber,
            password: 'Recovered-Passw0rd',
          })
        ).status,
      ).toBe(200);
    });

    it('rejects expired recovery links', async () => {
      const user = await createUser(ctx.prisma);
      await client().post('/auth/password-recovery', { accountNumber: user.accountNumber });
      const token = decodeURIComponent(/token=([^\s]+)/.exec(ctx.mailer.last().text)![1]!);
      ctx.clock.advance(31 * 60_000);
      expect(
        (
          await client().post('/auth/password-recovery/complete', {
            token,
            newPassword: 'Recovered-Passw0rd',
          })
        ).status,
      ).toBe(400);
    });
  });

  describe('database integrity', () => {
    it('refuses to change an account number', async () => {
      const user = await createUser(ctx.prisma);
      await expect(
        ctx.prisma.employee.update({
          where: { id: user.employeeId },
          data: { accountNumber: 'EMP-000999' },
        }),
      ).rejects.toThrow(/immutable/);
    });

    it('keeps the audit log append-only', async () => {
      await ctx.prisma.auditLog.create({ data: { action: 'test', entityType: 'test' } });
      await expect(ctx.prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
    });
  });

  it('reports health', async () => {
    const res = await client().get('/health');
    expect(res.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('returns a uniform 404 body for unknown routes', async () => {
    const user = await createUser(ctx.prisma);
    const c = client();
    await c.login(user);
    const res = await c.get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
