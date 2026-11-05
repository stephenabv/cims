import { Injectable } from '@nestjs/common';
import {
  type ChangePasswordInput,
  type ChangePinInput,
  type CurrentUser,
  ERROR_CODES,
  type LoginInput,
  type LoginResult,
  type PasswordRecoveryCompleteInput,
} from '@cims/shared';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  ConflictError,
  LockedError,
  UnauthenticatedError,
  ValidationError,
} from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { EncryptionService } from '../../infrastructure/crypto/encryption.service';
import { HashingService } from '../../infrastructure/crypto/hashing.service';
import { Mailer } from '../../infrastructure/mail/mailer';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { LockoutPolicy } from './domain/lockout-policy';
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  isRecoveryCodeFormat,
  normaliseRecoveryCode,
} from './domain/recovery-codes';
import { type IssuedSession, SessionService } from './session.service';
import { TotpService } from './totp.service';
import { HttpStatus } from '@nestjs/common';

const accountInclude = {
  employee: {
    select: { id: true, accountNumber: true, firstName: true, lastName: true, companyEmail: true },
  },
  role: { include: { permissions: { select: { permissionCode: true } } } },
} satisfies Prisma.UserAccountInclude;

type AccountWithRelations = Prisma.UserAccountGetPayload<{ include: typeof accountInclude }>;

const INVALID_CREDENTIALS_MESSAGE = 'Invalid account number or password';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly encryption: EncryptionService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly totp: TotpService,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
  ) {}

  // ───────────── Login ─────────────

  async login(
    input: LoginInput,
    client: ClientInfo,
  ): Promise<{ result: LoginResult; session: IssuedSession }> {
    const now = this.clock.now();
    const account = await this.findAccountByNumber(input.accountNumber);

    if (!account) {
      await this.hashing.verifyAgainstDummy(input.password);
      await this.audit.authEvent({
        type: 'LOGIN',
        success: false,
        accountNumber: input.accountNumber,
        reason: 'unknown_account',
        client,
      });
      throw new UnauthenticatedError(ERROR_CODES.INVALID_CREDENTIALS, INVALID_CREDENTIALS_MESSAGE);
    }

    const policy = await this.loginLockoutPolicy();
    if (
      policy.isLocked(
        { failedCount: account.failedLoginCount, lockedUntil: account.lockedUntil },
        now,
      )
    ) {
      await this.audit.authEvent({
        type: 'LOGIN',
        success: false,
        userId: account.id,
        accountNumber: input.accountNumber,
        reason: 'locked',
        client,
      });
      throw new LockedError(
        'Too many failed attempts. Try again later or contact IT.',
        account.lockedUntil!,
      );
    }

    const valid = await this.hashing.verifySecret(account.passwordHash, input.password);
    if (!valid) {
      await this.registerLoginFailure(account, policy, 'bad_password', client);
      throw new UnauthenticatedError(ERROR_CODES.INVALID_CREDENTIALS, INVALID_CREDENTIALS_MESSAGE);
    }

    // Status checks happen only after a correct password so they do not reveal account state.
    if (account.status !== 'ACTIVE') {
      await this.audit.authEvent({
        type: 'LOGIN',
        success: false,
        userId: account.id,
        accountNumber: input.accountNumber,
        reason: `status_${account.status.toLowerCase()}`,
        client,
      });
      throw new AppError(
        ERROR_CODES.ACCOUNT_INACTIVE,
        'This account is not active. Contact HR or IT.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (account.tempPasswordExpiresAt && account.tempPasswordExpiresAt <= now) {
      await this.audit.authEvent({
        type: 'LOGIN',
        success: false,
        userId: account.id,
        accountNumber: input.accountNumber,
        reason: 'temp_password_expired',
        client,
      });
      throw new AppError(
        ERROR_CODES.TEMP_PASSWORD_EXPIRED,
        'Your temporary password has expired. Request a new one.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const mfaRequired = account.role.requiresMfa || account.mfaEnabledAt !== null;
    const session = await this.prisma.$transaction(async (tx) => {
      await tx.userAccount.update({
        where: { id: account.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          ...(mfaRequired ? {} : { lastLoginAt: now }),
        },
      });
      await this.audit.authEvent(
        {
          type: 'LOGIN',
          success: true,
          userId: account.id,
          accountNumber: input.accountNumber,
          reason: mfaRequired ? 'password_ok_mfa_pending' : null,
          client,
        },
        tx,
      );
      return this.sessions.create(account.id, !mfaRequired, client, tx);
    });

    if (!mfaRequired)
      return { result: { status: 'AUTHENTICATED', user: this.toCurrentUser(account) }, session };
    return {
      result: { status: account.mfaEnabledAt ? 'MFA_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED' },
      session,
    };
  }

  async logout(auth: AuthContext, client: ClientInfo): Promise<void> {
    await this.sessions.revoke(auth.sessionId, 'logout');
    await this.audit.authEvent({ type: 'LOGOUT', success: true, userId: auth.userId, client });
  }

  async currentUser(userId: string): Promise<CurrentUser> {
    const account = await this.prisma.userAccount.findUniqueOrThrow({
      where: { id: userId },
      include: accountInclude,
    });
    return this.toCurrentUser(account);
  }

  // ───────────── Two-factor ─────────────

  async startMfaEnrollment(auth: AuthContext): Promise<{ secret: string; otpauthUrl: string }> {
    const account = await this.prisma.userAccount.findUniqueOrThrow({
      where: { id: auth.userId },
      include: accountInclude,
    });
    if (account.mfaEnabledAt)
      throw new ConflictError('Two-factor authentication is already enabled');
    const secret = this.totp.generateSecret();
    await this.prisma.userAccount.update({
      where: { id: auth.userId },
      data: { mfaSecretEnc: this.encryption.encrypt(secret) },
    });
    const issuer = await this.settings.get('company.name');
    return {
      secret,
      otpauthUrl: this.totp.keyUri(account.employee.accountNumber, `${issuer} CIMS`, secret),
    };
  }

  async confirmMfaEnrollment(
    auth: AuthContext,
    code: string,
    client: ClientInfo,
  ): Promise<{ recoveryCodes: string[]; session: IssuedSession; user: CurrentUser }> {
    const account = await this.prisma.userAccount.findUniqueOrThrow({ where: { id: auth.userId } });
    if (account.mfaEnabledAt)
      throw new ConflictError('Two-factor authentication is already enabled');
    if (!account.mfaSecretEnc) throw new ConflictError('Start enrolment first');
    const step = this.totp.verify(this.encryption.decrypt(account.mfaSecretEnc), code, null);
    if (step === null)
      throw new UnauthenticatedError(ERROR_CODES.MFA_INVALID, 'The code is not valid');

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const session = await this.prisma.$transaction(async (tx) => {
      const now = this.clock.now();
      await tx.userAccount.update({
        where: { id: auth.userId },
        data: { mfaEnabledAt: now, mfaLastStep: step, lastLoginAt: now },
      });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: auth.userId } });
      await tx.mfaRecoveryCode.createMany({
        data: recoveryCodes.map((c) => ({
          userId: auth.userId,
          codeHash: this.hashing.sha256(normaliseRecoveryCode(c)),
        })),
      });
      await this.audit.authEvent(
        { type: 'MFA_ENROLLED', success: true, userId: auth.userId, client },
        tx,
      );
      return this.sessions.rotate(auth.sessionId, client, { mfaVerified: true }, tx);
    });
    return { recoveryCodes, session, user: await this.currentUser(auth.userId) };
  }

  async verifyMfa(
    auth: AuthContext,
    code: string,
    client: ClientInfo,
  ): Promise<{ session: IssuedSession; user: CurrentUser }> {
    const now = this.clock.now();
    const account = await this.prisma.userAccount.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!account.mfaEnabledAt || !account.mfaSecretEnc)
      throw new ConflictError('Two-factor authentication is not enrolled');

    const policy = await this.loginLockoutPolicy();
    if (
      policy.isLocked(
        { failedCount: account.failedLoginCount, lockedUntil: account.lockedUntil },
        now,
      )
    ) {
      throw new LockedError(
        'Too many failed attempts. Try again later or contact IT.',
        account.lockedUntil!,
      );
    }

    let accepted = false;
    let newStep: bigint | null = null;
    let recoveryCodeId: string | null = null;
    if (isRecoveryCodeFormat(code)) {
      const match = await this.prisma.mfaRecoveryCode.findFirst({
        where: {
          userId: account.id,
          usedAt: null,
          codeHash: this.hashing.sha256(normaliseRecoveryCode(code)),
        },
      });
      accepted = !!match;
      recoveryCodeId = match?.id ?? null;
    } else {
      newStep = this.totp.verify(
        this.encryption.decrypt(account.mfaSecretEnc),
        code,
        account.mfaLastStep,
      );
      accepted = newStep !== null;
    }

    if (!accepted) {
      const next = policy.registerFailure(
        { failedCount: account.failedLoginCount, lockedUntil: account.lockedUntil },
        now,
      );
      await this.prisma.userAccount.update({
        where: { id: account.id },
        data: { failedLoginCount: next.failedCount, lockedUntil: next.lockedUntil },
      });
      await this.audit.authEvent({
        type: 'MFA_CHALLENGE',
        success: false,
        userId: account.id,
        reason: 'bad_code',
        client,
      });
      if (next.justLocked) {
        await this.sessions.revoke(auth.sessionId, 'mfa_lockout');
        await this.audit.authEvent({
          type: 'ACCOUNT_LOCKED',
          success: true,
          userId: account.id,
          reason: 'mfa_failures',
          client,
        });
      }
      throw new UnauthenticatedError(ERROR_CODES.MFA_INVALID, 'The code is not valid');
    }

    const session = await this.prisma.$transaction(async (tx) => {
      if (recoveryCodeId) {
        // Conditional update guards against two concurrent uses of the same recovery code.
        const used = await tx.mfaRecoveryCode.updateMany({
          where: { id: recoveryCodeId, usedAt: null },
          data: { usedAt: now },
        });
        if (used.count !== 1)
          throw new UnauthenticatedError(ERROR_CODES.MFA_INVALID, 'The code is not valid');
      }
      await tx.userAccount.update({
        where: { id: account.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now,
          ...(newStep !== null ? { mfaLastStep: newStep } : {}),
        },
      });
      await this.audit.authEvent(
        {
          type: 'MFA_CHALLENGE',
          success: true,
          userId: account.id,
          reason: recoveryCodeId ? 'recovery_code' : 'totp',
          client,
        },
        tx,
      );
      return this.sessions.rotate(auth.sessionId, client, { mfaVerified: true }, tx);
    });
    return { session, user: await this.currentUser(account.id) };
  }

  // ───────────── Credentials self-service ─────────────

  async changePassword(
    auth: AuthContext,
    input: ChangePasswordInput,
    client: ClientInfo,
  ): Promise<void> {
    const account = await this.prisma.userAccount.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await this.hashing.verifySecret(account.passwordHash, input.currentPassword))) {
      await this.audit.authEvent({
        type: 'PASSWORD_CHANGED',
        success: false,
        userId: auth.userId,
        reason: 'bad_current_password',
        client,
      });
      throw new ValidationError([
        { path: 'currentPassword', message: 'Current password is incorrect' },
      ]);
    }
    const passwordHash = await this.hashing.hashSecret(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.userAccount.update({
        where: { id: auth.userId },
        data: {
          passwordHash,
          passwordChangedAt: this.clock.now(),
          mustChangePassword: false,
          tempPasswordExpiresAt: null,
        },
      });
      // Keep the current session; sign out everywhere else.
      await this.sessions.revokeAllForUser(auth.userId, 'password_changed', tx, auth.sessionId);
      await this.audit.authEvent(
        { type: 'PASSWORD_CHANGED', success: true, userId: auth.userId, client },
        tx,
      );
    });
  }

  async changePin(auth: AuthContext, input: ChangePinInput, client: ClientInfo): Promise<void> {
    const account = await this.prisma.userAccount.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await this.hashing.verifySecret(account.passwordHash, input.currentPassword))) {
      await this.audit.authEvent({
        type: 'PIN_CHANGED',
        success: false,
        userId: auth.userId,
        reason: 'bad_current_password',
        client,
      });
      throw new ValidationError([
        { path: 'currentPassword', message: 'Current password is incorrect' },
      ]);
    }
    const pinHash = await this.hashing.hashSecret(input.newPin);
    await this.prisma.$transaction(async (tx) => {
      await tx.userAccount.update({
        where: { id: auth.userId },
        data: { pinHash, pinChangedAt: this.clock.now(), failedPinCount: 0, pinLockedUntil: null },
      });
      await this.audit.authEvent(
        { type: 'PIN_CHANGED', success: true, userId: auth.userId, client },
        tx,
      );
    });
  }

  /** Always resolves without revealing whether the account exists (prevents enumeration). */
  async requestPasswordRecovery(
    accountNumber: string,
    client: ClientInfo,
    resetUrlBase: string,
  ): Promise<void> {
    const account = await this.findAccountByNumber(accountNumber);
    if (!account || account.status !== 'ACTIVE') {
      await this.audit.authEvent({
        type: 'PASSWORD_RECOVERY_REQUESTED',
        success: false,
        accountNumber,
        reason: account ? 'inactive' : 'unknown_account',
        client,
      });
      return;
    }
    const ttl = await this.settings.get('security.passwordResetTtlMinutes');
    const token = this.hashing.randomToken(32);
    const expiresAt = new Date(this.clock.now().getTime() + ttl * 60_000);
    await this.prisma.$transaction(async (tx) => {
      // Only the newest link is valid.
      await tx.passwordResetToken.updateMany({
        where: { userId: account.id, usedAt: null },
        data: { usedAt: this.clock.now() },
      });
      await tx.passwordResetToken.create({
        data: { userId: account.id, tokenHash: this.hashing.sha256(token), expiresAt },
      });
      await this.audit.authEvent(
        {
          type: 'PASSWORD_RECOVERY_REQUESTED',
          success: true,
          userId: account.id,
          accountNumber,
          client,
        },
        tx,
      );
    });
    await this.mailer.send({
      to: account.employee.companyEmail,
      subject: 'CIMS password reset',
      text:
        `Hello ${account.employee.firstName},\n\nA password reset was requested for account ${account.employee.accountNumber}.\n` +
        `Open this link within ${ttl} minutes to choose a new password:\n\n${resetUrlBase}?token=${encodeURIComponent(token)}\n\n` +
        `If you did not request this, ignore this email and inform IT.`,
    });
  }

  async completePasswordRecovery(
    input: PasswordRecoveryCompleteInput,
    client: ClientInfo,
  ): Promise<void> {
    const now = this.clock.now();
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashing.sha256(input.token) },
      include: { user: true },
    });
    if (!record || record.usedAt || record.expiresAt <= now || record.user.status !== 'ACTIVE') {
      await this.audit.authEvent({
        type: 'PASSWORD_RECOVERY_COMPLETED',
        success: false,
        userId: record?.userId ?? null,
        reason: 'invalid_token',
        client,
      });
      throw new ValidationError([
        { path: 'token', message: 'This reset link is invalid or has expired' },
      ]);
    }
    const passwordHash = await this.hashing.hashSecret(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: now },
      });
      if (consumed.count !== 1)
        throw new ValidationError([
          { path: 'token', message: 'This reset link is invalid or has expired' },
        ]);
      await tx.userAccount.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          passwordChangedAt: now,
          mustChangePassword: false,
          tempPasswordExpiresAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await this.sessions.revokeAllForUser(record.userId, 'password_reset', tx);
      await this.audit.authEvent(
        { type: 'PASSWORD_RECOVERY_COMPLETED', success: true, userId: record.userId, client },
        tx,
      );
    });
  }

  // ───────────── helpers ─────────────

  private findAccountByNumber(accountNumber: string): Promise<AccountWithRelations | null> {
    return this.prisma.userAccount.findFirst({
      where: { employee: { accountNumber } },
      include: accountInclude,
    });
  }

  private async loginLockoutPolicy(): Promise<LockoutPolicy> {
    const s = await this.settings.getMany([
      'security.loginMaxAttempts',
      'security.lockoutMinutes',
    ] as const);
    return new LockoutPolicy({
      maxAttempts: s['security.loginMaxAttempts'],
      lockoutMinutes: s['security.lockoutMinutes'],
    });
  }

  private async registerLoginFailure(
    account: AccountWithRelations,
    policy: LockoutPolicy,
    reason: string,
    client: ClientInfo,
  ): Promise<void> {
    const next = policy.registerFailure(
      { failedCount: account.failedLoginCount, lockedUntil: account.lockedUntil },
      this.clock.now(),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.userAccount.update({
        where: { id: account.id },
        data: { failedLoginCount: next.failedCount, lockedUntil: next.lockedUntil },
      });
      await this.audit.authEvent(
        {
          type: 'LOGIN',
          success: false,
          userId: account.id,
          accountNumber: account.employee.accountNumber,
          reason,
          client,
        },
        tx,
      );
      if (next.justLocked) {
        await this.audit.authEvent(
          {
            type: 'ACCOUNT_LOCKED',
            success: true,
            userId: account.id,
            reason: 'login_failures',
            client,
          },
          tx,
        );
      }
    });
  }

  private toCurrentUser(account: AccountWithRelations): CurrentUser {
    return {
      id: account.id,
      employeeId: account.employee.id,
      accountNumber: account.employee.accountNumber,
      fullName: `${account.employee.firstName} ${account.employee.lastName}`,
      email: account.employee.companyEmail,
      role: { key: account.role.key, name: account.role.name },
      permissions: account.role.permissions.map((p) => p.permissionCode).sort(),
      mustChangePassword: account.mustChangePassword,
      mfaEnabled: account.mfaEnabledAt !== null,
      mfaRequired: account.role.requiresMfa,
    };
  }
}
