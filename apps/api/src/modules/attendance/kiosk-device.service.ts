import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { HashingService } from '../../infrastructure/crypto/hashing.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class KioskDeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  list() {
    return this.prisma.kioskDevice.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, lastSeenAt: true, revokedAt: true, createdAt: true },
    });
  }

  /** Returns the raw token exactly once; only its hash is stored. */
  async register(
    actor: AuthContext,
    name: string,
    client: ClientInfo,
  ): Promise<{ id: string; name: string; token: string }> {
    const token = `kio_${this.hashing.randomToken(32)}`;
    const device = await this.prisma.$transaction(async (tx) => {
      const d = await tx.kioskDevice.create({
        data: { name, tokenHash: this.hashing.sha256(token), createdById: actor.userId },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'kiosk.register',
          entityType: 'kiosk_device',
          entityId: d.id,
          after: { name },
          client,
        },
        tx,
      );
      return d;
    });
    return { id: device.id, name: device.name, token };
  }

  async revoke(actor: AuthContext, id: string, client: ClientInfo): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.kioskDevice.findUnique({ where: { id } });
      if (!d) throw new NotFoundError('Kiosk device');
      if (d.revokedAt) return;
      await tx.kioskDevice.update({ where: { id }, data: { revokedAt: this.clock.now() } });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'kiosk.revoke',
          entityType: 'kiosk_device',
          entityId: id,
          client,
        },
        tx,
      );
    });
  }

  /** Resolves an active device from its raw token, recording that it was seen. */
  async authenticate(token: string | undefined): Promise<{ id: string; name: string } | null> {
    if (!token || token.length > 128) return null;
    const d = await this.prisma.kioskDevice.findUnique({
      where: { tokenHash: this.hashing.sha256(token) },
    });
    if (!d || d.revokedAt) return null;
    const now = this.clock.now();
    if (!d.lastSeenAt || now.getTime() - d.lastSeenAt.getTime() > 60_000) {
      await this.prisma.kioskDevice.update({ where: { id: d.id }, data: { lastSeenAt: now } });
    }
    return { id: d.id, name: d.name };
  }
}
