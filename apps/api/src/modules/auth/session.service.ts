import { Injectable } from '@nestjs/common';
import { isPermissionCode, type PermissionCode } from '@cims/shared';
import { Clock } from '../../infrastructure/clock/clock';
import { HashingService } from '../../infrastructure/crypto/hashing.service';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { SettingsService } from '../settings/settings.service';

/** Avoid a write on every request: refresh last_seen_at at most once per minute. */
const TOUCH_INTERVAL_MS = 60_000;

export interface IssuedSession {
  sessionId: string;
  token: string;
  expiresAt: Date;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  async create(
    userId: string,
    mfaVerified: boolean,
    client: ClientInfo,
    tx: PrismaTx = this.prisma,
  ): Promise<IssuedSession> {
    const now = this.clock.now();
    const hours = await this.settings.get('security.sessionAbsoluteHours', tx);
    const token = this.hashing.randomToken(32);
    const expiresAt = new Date(now.getTime() + hours * 3_600_000);
    const session = await tx.session.create({
      data: {
        userId,
        tokenHash: this.hashing.sha256(token),
        mfaVerified,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        ip: client.ip,
        userAgent: client.userAgent,
      },
    });
    return { sessionId: session.id, token, expiresAt };
  }

  /**
   * Resolves a raw cookie token to an auth context, or null when the session is missing,
   * revoked, expired (absolute or idle), or the account is no longer active.
   */
  async resolve(token: string): Promise<AuthContext | null> {
    if (!token || token.length > 128) return null;
    const now = this.clock.now();
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: this.hashing.sha256(token) },
      include: {
        user: {
          include: {
            employee: { select: { accountNumber: true } },
            role: { include: { permissions: { select: { permissionCode: true } } } },
          },
        },
      },
    });
    if (!session || session.revokedAt || session.expiresAt <= now) return null;

    const idleMinutes = await this.settings.get('security.sessionIdleMinutes');
    if (session.lastSeenAt.getTime() + idleMinutes * 60_000 <= now.getTime()) {
      await this.revoke(session.id, 'idle_timeout');
      return null;
    }
    if (session.user.status !== 'ACTIVE') {
      await this.revoke(session.id, 'account_inactive');
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }

    const permissions = new Set<PermissionCode>(
      session.user.role.permissions.map((p) => p.permissionCode).filter(isPermissionCode),
    );
    return {
      sessionId: session.id,
      userId: session.userId,
      employeeId: session.user.employeeId,
      accountNumber: session.user.employee.accountNumber,
      roleKey: session.user.role.key,
      permissions,
      mfaVerified: session.mfaVerified,
      mustChangePassword: session.user.mustChangePassword,
    };
  }

  /** Replaces a session with a new token (prevents fixation when privilege level changes). */
  async rotate(
    sessionId: string,
    client: ClientInfo,
    opts: { mfaVerified: boolean },
    tx: PrismaTx = this.prisma,
  ): Promise<IssuedSession> {
    const old = await tx.session.findUniqueOrThrow({ where: { id: sessionId } });
    await tx.session.update({
      where: { id: sessionId },
      data: { revokedAt: this.clock.now(), revokedReason: 'rotated' },
    });
    return this.create(old.userId, opts.mfaVerified, client, tx);
  }

  async revoke(sessionId: string, reason: string, tx: PrismaTx = this.prisma): Promise<void> {
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
  }

  async revokeAllForUser(
    userId: string,
    reason: string,
    tx: PrismaTx = this.prisma,
    exceptSessionId?: string,
  ): Promise<number> {
    const res = await tx.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
    return res.count;
  }

  /** Housekeeping: delete sessions that ended more than a day ago. */
  async purgeExpired(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - 86_400_000);
    const res = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    return res.count;
  }
}
