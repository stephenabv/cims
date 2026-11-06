import { Injectable } from '@nestjs/common';
import type { ClientInfo } from '../../common/http/request-context';
import { HashingService } from '../../infrastructure/crypto/hashing.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LockoutPolicy } from '../auth/domain/lockout-policy';
import { SettingsService } from '../settings/settings.service';

export interface KioskIdentity {
  userId: string;
  employeeId: string;
  firstName: string;
  lastName: string;
}

export type IdentityResult =
  | { ok: true; identity: KioskIdentity }
  | { ok: false; reason: 'INVALID_CREDENTIALS' }
  | { ok: false; reason: 'LOCKED'; lockedUntil: Date }
  | { ok: false; reason: 'INACTIVE' };

/**
 * Credential A (account number + attendance PIN) verification shared by online punches and
 * offline sync, so both enforce the same PIN lockout and leave the same audit trail.
 */
@Injectable()
export class KioskIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async verify(
    accountNumber: string,
    pin: string,
    now: Date,
    client: ClientInfo,
  ): Promise<IdentityResult> {
    const account = await this.prisma.userAccount.findFirst({
      where: { employee: { accountNumber } },
      include: { employee: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (!account) {
      // Spend the same time as a real check so response timing does not reveal valid accounts.
      await this.hashing.verifyAgainstDummy(pin);
      await this.audit.authEvent({
        type: 'PIN_VERIFY',
        success: false,
        accountNumber,
        reason: 'unknown_account',
        client,
      });
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    const s = await this.settings.getMany([
      'security.pinMaxAttempts',
      'security.pinLockoutMinutes',
    ] as const);
    const policy = new LockoutPolicy({
      maxAttempts: s['security.pinMaxAttempts'],
      lockoutMinutes: s['security.pinLockoutMinutes'],
    });
    const state = { failedCount: account.failedPinCount, lockedUntil: account.pinLockedUntil };
    const fail = (reason: string) =>
      this.audit.authEvent({
        type: 'PIN_VERIFY',
        success: false,
        userId: account.id,
        accountNumber,
        reason,
        client,
      });

    if (policy.isLocked(state, now)) {
      await fail('locked');
      return { ok: false, reason: 'LOCKED', lockedUntil: account.pinLockedUntil! };
    }
    if (!(await this.hashing.verifySecret(account.pinHash, pin))) {
      const next = policy.registerFailure(state, now);
      await this.prisma.userAccount.update({
        where: { id: account.id },
        data: { failedPinCount: next.failedCount, pinLockedUntil: next.lockedUntil },
      });
      await fail('bad_pin');
      if (next.justLocked)
        await this.audit.authEvent({
          type: 'ACCOUNT_LOCKED',
          success: true,
          userId: account.id,
          reason: 'pin_failures',
          client,
        });
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }
    if (account.failedPinCount > 0 || account.pinLockedUntil) {
      await this.prisma.userAccount.update({
        where: { id: account.id },
        data: { failedPinCount: 0, pinLockedUntil: null },
      });
    }
    if (account.status !== 'ACTIVE') {
      await fail(`status_${account.status.toLowerCase()}`);
      return { ok: false, reason: 'INACTIVE' };
    }
    return {
      ok: true,
      identity: {
        userId: account.id,
        employeeId: account.employee.id,
        firstName: account.employee.firstName,
        lastName: account.employee.lastName,
      },
    };
  }
}
