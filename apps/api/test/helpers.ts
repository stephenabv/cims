import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { ALL_PERMISSION_CODES, type PermissionCode, type SystemRoleKey } from '@cims/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadEnv } from '../src/common/config/env';
import { Clock } from '../src/infrastructure/clock/clock';
import { Mailer, type MailMessage } from '../src/infrastructure/mail/mailer';
import { DEFAULT_ROLES, PERMISSION_DESCRIPTIONS } from '../src/modules/access/default-roles';

export class FakeMailer extends Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
  last(): MailMessage {
    const m = this.sent.at(-1);
    if (!m) throw new Error('No mail sent');
    return m;
  }
}

export class MutableClock extends Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
  reset(): void {
    this.offsetMs = 0;
  }
}

/** In-memory throttler storage that never limits, so lockout logic (not IP throttling) is what tests observe. */
class NoopThrottlerStorage implements ThrottlerStorage {
  async increment(): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> {
    return { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };
  }
}

export interface TestContext {
  app: INestApplication;
  prisma: PrismaClient;
  mailer: FakeMailer;
  clock: MutableClock;
}

export async function createTestApp(opts: { throttle?: boolean } = {}): Promise<TestContext> {
  const mailer = new FakeMailer();
  const clock = new MutableClock();
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Mailer)
    .useValue(mailer)
    .overrideProvider(Clock)
    .useValue(clock);
  if (!opts.throttle)
    builder = builder.overrideProvider(ThrottlerStorage).useValue(new NoopThrottlerStorage());
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, loadEnv());
  await app.init();
  const prisma = new PrismaClient();
  await seedAccessControl(prisma);
  return { app, prisma, mailer, clock };
}

export async function resetData(prisma: PrismaClient): Promise<void> {
  // Append-only triggers block DELETE on audit tables, so TRUNCATE (which bypasses row triggers) is used.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE session, password_reset_token, mfa_recovery_code, auth_event, audit_log, employee_change_history, user_account, employee, position, department, company_setting RESTART IDENTITY CASCADE',
  );
  await prisma.companySetting.create({
    data: { key: 'company.allowedEmailDomains', value: ['acme.test'] },
  });
}

async function seedAccessControl(prisma: PrismaClient): Promise<void> {
  for (const code of ALL_PERMISSION_CODES) {
    await prisma.permission.upsert({
      where: { code },
      create: { code, description: PERMISSION_DESCRIPTIONS[code] },
      update: {},
    });
  }
  for (const role of DEFAULT_ROLES) {
    await prisma.role.upsert({
      where: { key: role.key },
      create: {
        key: role.key,
        name: role.name,
        isSystem: true,
        requiresMfa: role.requiresMfa,
        permissions: { create: role.permissions.map((permissionCode) => ({ permissionCode })) },
      },
      update: {},
    });
  }
}

let seq = 0;

export interface TestUser {
  userId: string;
  employeeId: string;
  accountNumber: string;
  password: string;
  pin: string;
  email: string;
}

export async function createUser(
  prisma: PrismaClient,
  opts: {
    role?: SystemRoleKey;
    status?: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'PENDING_ACTIVATION';
    mustChangePassword?: boolean;
    tempPasswordExpiresAt?: Date | null;
    requiresMfaOverride?: boolean;
  } = {},
): Promise<TestUser> {
  seq += 1;
  const accountNumber = `EMP-${String(900000 + seq).padStart(6, '0')}`;
  const password = 'Valid-Password-123';
  const pin = '482915';
  const email = `user${seq}@acme.test`;
  const role = await prisma.role.findUniqueOrThrow({ where: { key: opts.role ?? 'STAFF' } });
  const employee = await prisma.employee.create({
    data: {
      accountNumber,
      firstName: 'Test',
      lastName: `User${seq}`,
      companyEmail: email,
      dateHired: new Date('2026-01-05'),
    },
  });
  const account = await prisma.userAccount.create({
    data: {
      employeeId: employee.id,
      roleId: role.id,
      status: opts.status ?? 'ACTIVE',
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      mustChangePassword: opts.mustChangePassword ?? false,
      tempPasswordExpiresAt: opts.tempPasswordExpiresAt ?? null,
      pinHash: await argon2.hash(pin, { type: argon2.argon2id }),
    },
  });
  return { userId: account.id, employeeId: employee.id, accountNumber, password, pin, email };
}

/** Cookie-aware HTTP client that handles the CSRF handshake like the SPA does. */
export class Client {
  private cookies = new Map<string, string>();

  constructor(private readonly app: INestApplication) {}

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private capture(res: request.Response): void {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    for (const c of raw ?? []) {
      const [pair] = c.split(';');
      const idx = pair!.indexOf('=');
      const name = pair!.slice(0, idx);
      const value = decodeURIComponent(pair!.slice(idx + 1));
      if (value === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  async csrf(): Promise<void> {
    this.capture(await request(this.app.getHttpServer()).get('/api/v1/auth/csrf'));
  }

  async get(path: string): Promise<request.Response> {
    const res = await request(this.app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Cookie', this.cookieHeader());
    this.capture(res);
    return res;
  }

  async send(
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: object,
    opts: { csrf?: boolean } = {},
  ): Promise<request.Response> {
    if (opts.csrf !== false && !this.cookies.has('cims_csrf')) await this.csrf();
    let req = request(this.app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Cookie', this.cookieHeader());
    if (opts.csrf !== false) req = req.set('X-CSRF-Token', this.cookies.get('cims_csrf') ?? '');
    const res = await (body ? req.send(body) : req);
    this.capture(res);
    return res;
  }

  post(path: string, body?: object, opts?: { csrf?: boolean }): Promise<request.Response> {
    return this.send('post', path, body, opts);
  }

  async login(user: Pick<TestUser, 'accountNumber' | 'password'>): Promise<request.Response> {
    return this.post('/auth/login', { accountNumber: user.accountNumber, password: user.password });
  }
}

export const permissionSet = (codes: PermissionCode[]) => new Set(codes);

/** Signs in a user whose role requires 2FA, enrolling TOTP on the way. */
export async function loginPrivileged(c: Client, user: TestUser): Promise<void> {
  const { authenticator } = await import('otplib');
  const login = await c.login(user);
  if (login.body.status !== 'MFA_ENROLLMENT_REQUIRED')
    throw new Error(`Unexpected login status ${JSON.stringify(login.body)}`);
  const start = await c.post('/auth/mfa/enroll');
  const confirm = await c.post('/auth/mfa/enroll/confirm', {
    code: authenticator.generate(start.body.secret),
  });
  if (confirm.status !== 200) throw new Error('MFA enrolment failed');
}
