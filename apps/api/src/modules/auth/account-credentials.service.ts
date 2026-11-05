import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { isWeakPin } from '@cims/shared';
import { NotFoundError } from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { HashingService } from '../../infrastructure/crypto/hashing.service';
import { Mailer } from '../../infrastructure/mail/mailer';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { generateTemporaryPassword } from './domain/recovery-codes';
import { SessionService } from './session.service';

export function generatePin(): string {
  let pin: string;
  do {
    pin = randomInt(0, 1_000_000).toString().padStart(6, '0');
  } while (isWeakPin(pin));
  return pin;
}

/**
 * Administrative credential operations (HR/IT, §3.2). New secrets are delivered only to the
 * employee's registered company email — never returned to the operator — so an administrator
 * cannot take over another person's account by resetting it.
 */
@Injectable()
export class AccountCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
  ) {}

  async issueTemporaryPassword(
    actor: AuthContext,
    userId: string,
    client: ClientInfo,
  ): Promise<{ expiresAt: Date }> {
    const account = await this.prisma.userAccount.findUnique({
      where: { id: userId },
      include: { employee: true },
    });
    if (!account) throw new NotFoundError('Account');
    const ttlHours = await this.settings.get('security.tempPasswordTtlHours');
    const tempPassword = generateTemporaryPassword();
    const passwordHash = await this.hashing.hashSecret(tempPassword);
    const expiresAt = new Date(this.clock.now().getTime() + ttlHours * 3_600_000);

    await this.prisma.$transaction(async (tx) => {
      await tx.userAccount.update({
        where: { id: userId },
        data: {
          passwordHash,
          mustChangePassword: true,
          tempPasswordExpiresAt: expiresAt,
          failedLoginCount: 0,
          lockedUntil: null,
          passwordChangedAt: this.clock.now(),
        },
      });
      await this.sessions.revokeAllForUser(userId, 'temporary_password_issued', tx);
      await this.audit.authEvent(
        { type: 'TEMP_PASSWORD_ISSUED', success: true, userId, client },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'account.temporary_password_issued',
          entityType: 'user_account',
          entityId: userId,
          metadata: { expiresAt },
          client,
        },
        tx,
      );
    });
    await this.mailer.send({
      to: account.employee.companyEmail,
      subject: 'Your CIMS temporary password',
      text:
        `Hello ${account.employee.firstName},\n\nA temporary password was issued for account ${account.employee.accountNumber}:\n\n` +
        `    ${tempPassword}\n\nIt expires on ${expiresAt.toISOString()} and must be changed when you first sign in.`,
    });
    return { expiresAt };
  }

  async resetPin(actor: AuthContext, userId: string, client: ClientInfo): Promise<void> {
    const account = await this.prisma.userAccount.findUnique({
      where: { id: userId },
      include: { employee: true },
    });
    if (!account) throw new NotFoundError('Account');
    const pin = generatePin();
    const pinHash = await this.hashing.hashSecret(pin);
    await this.prisma.$transaction(async (tx) => {
      await tx.userAccount.update({
        where: { id: userId },
        data: { pinHash, pinChangedAt: this.clock.now(), failedPinCount: 0, pinLockedUntil: null },
      });
      await this.audit.authEvent({ type: 'PIN_RESET', success: true, userId, client }, tx);
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'account.pin_reset',
          entityType: 'user_account',
          entityId: userId,
          client,
        },
        tx,
      );
    });
    await this.mailer.send({
      to: account.employee.companyEmail,
      subject: 'Your CIMS attendance PIN was reset',
      text: `Hello ${account.employee.firstName},\n\nYour new attendance PIN is ${pin}. You can change it from your profile after signing in.`,
    });
  }
}
