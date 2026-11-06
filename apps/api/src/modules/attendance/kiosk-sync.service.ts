import { Injectable, Logger } from '@nestjs/common';
import {
  type KioskSyncInput,
  type KioskSyncResult,
  type OfflinePunchPayload,
  type SyncItemStatus,
  offlinePunchPayloadSchema,
} from '@cims/shared';
import { Prisma } from '@prisma/client';
import type { ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { AttendanceDayService } from './attendance-day.service';
import { type OfflinePolicy, assessOfflinePunch } from './domain/offline-punch';
import { dateColumn, fromDateColumn, workDateOf } from './domain/work-date';
import { KioskIdentityService } from './kiosk-identity.service';
import { KioskSyncKeyService } from './kiosk-sync-key.service';

type ItemResult = KioskSyncResult['results'][number];

/** Device clocks may run ahead of the server by at most this much. */
const MAX_CLOCK_SKEW_MS = 2 * 60_000;

/**
 * Applies a kiosk's offline outbox (spec §4, architecture §6). Idempotent per `clientUuid`.
 * Items are processed oldest first so a time-in and its time-out from the same outage pair up.
 * Each item is applied in its own transaction under the employee row lock used by online punches.
 */
@Injectable()
export class KioskSyncService {
  private readonly logger = new Logger(KioskSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KioskSyncKeyService,
    private readonly identity: KioskIdentityService,
    private readonly settings: SettingsService,
    private readonly days: AttendanceDayService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async sync(
    deviceId: string,
    input: KioskSyncInput,
    client: ClientInfo,
  ): Promise<KioskSyncResult> {
    const now = this.clock.now();
    const s = await this.settings.getMany([
      'company.timezone',
      'attendance.duplicateWindowSeconds',
      'attendance.maxShiftHours',
      'attendance.maxOfflineHours',
    ] as const);
    const policy: OfflinePolicy = {
      duplicateWindowMs: s['attendance.duplicateWindowSeconds'] * 1000,
      maxShiftMs: s['attendance.maxShiftHours'] * 3_600_000,
      maxClockSkewMs: MAX_CLOCK_SKEW_MS,
      maxOfflineAgeMs: s['attendance.maxOfflineHours'] * 3_600_000,
    };

    const results = new Map<string, ItemResult>();
    const decoded: OfflinePunchPayload[] = [];
    for (const item of input.items) {
      const payload = await this.decode(item.keyId, item.ciphertext);
      // The client UUID is inside the ciphertext so a captured payload cannot be replayed under a new id.
      if (!payload || payload.clientUuid !== item.clientUuid) {
        results.set(item.clientUuid, {
          clientUuid: item.clientUuid,
          status: 'REJECTED',
          reason: 'INVALID_PAYLOAD',
        });
      } else {
        decoded.push(payload);
      }
    }
    decoded.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));

    for (const payload of decoded) {
      results.set(
        payload.clientUuid,
        await this.applyOne(payload, deviceId, now, policy, s['company.timezone'], client),
      );
    }

    const ordered = input.items.map((i) => results.get(i.clientUuid)!);
    await this.recordBatch(deviceId, ordered, client);
    return { results: ordered };
  }

  private async decode(keyId: string, ciphertext: string): Promise<OfflinePunchPayload | null> {
    const json = await this.keys.decrypt(keyId, ciphertext);
    if (json === null) return null;
    try {
      const parsed = offlinePunchPayloadSchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async applyOne(
    p: OfflinePunchPayload,
    deviceId: string,
    now: Date,
    policy: OfflinePolicy,
    timezone: string,
    client: ClientInfo,
  ): Promise<ItemResult> {
    const result = (status: SyncItemStatus, reason?: string): ItemResult => ({
      clientUuid: p.clientUuid,
      status,
      ...(reason ? { reason } : {}),
    });

    if (
      await this.prisma.attendanceEvent.findUnique({
        where: { clientUuid: p.clientUuid },
        select: { id: true },
      })
    ) {
      return result('DUPLICATE');
    }
    const verified = await this.identity.verify(p.accountNumber, p.pin, now, client);
    if (!verified.ok) {
      // A locked PIN may unlock later; keep the item queued rather than losing a genuine punch.
      if (verified.reason === 'LOCKED') return result('DEFERRED', 'PIN_LOCKED');
      return result(
        'REJECTED',
        verified.reason === 'INACTIVE' ? 'ACCOUNT_INACTIVE' : 'INVALID_CREDENTIALS',
      );
    }
    const employeeId = verified.identity.employeeId;
    const at = new Date(p.occurredAt);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM employee WHERE id = ${employeeId}::uuid FOR UPDATE`;
        const [previous, next] = await Promise.all([
          tx.attendanceEvent.findFirst({
            where: { employeeId, status: 'ACCEPTED', occurredAt: { lte: at } },
            orderBy: { occurredAt: 'desc' },
          }),
          tx.attendanceEvent.findFirst({
            where: { employeeId, status: 'ACCEPTED', occurredAt: { gt: at } },
            orderBy: { occurredAt: 'asc' },
          }),
        ]);
        const toPunch = (e: typeof previous) => (e ? { type: e.type, at: e.occurredAt } : null);
        const decision = assessOfflinePunch(
          { type: p.type, at },
          toPunch(previous),
          toPunch(next),
          now,
          policy,
        );
        if (decision.kind === 'DUPLICATE') return result('DUPLICATE');
        if (decision.kind === 'REJECT') return result('REJECTED', decision.reason);

        // A time-out belongs to the work date of the time-in it closes.
        const workDate =
          p.type === 'TIME_OUT' && previous?.type === 'TIME_IN'
            ? fromDateColumn(previous.workDate)
            : workDateOf(at, timezone);
        const event = await tx.attendanceEvent.create({
          data: {
            employeeId,
            type: p.type,
            occurredAt: at,
            recordedAt: now,
            workDate: dateColumn(workDate),
            source: 'KIOSK_OFFLINE',
            status: decision.kind === 'APPLY' ? 'ACCEPTED' : 'CONFLICT',
            deviceId,
            clientUuid: p.clientUuid,
          },
        });
        await this.audit.authEvent(
          {
            type: 'PIN_VERIFY',
            success: true,
            userId: verified.identity.userId,
            accountNumber: p.accountNumber,
            reason: `offline_${p.type.toLowerCase()}`,
            client,
          },
          tx,
        );
        if (decision.kind === 'CONFLICT') {
          await tx.attendanceConflict.create({
            data: { eventId: event.id, employeeId, reason: decision.reason },
          });
          return result('CONFLICT', decision.reason);
        }
        await this.days.recompute(tx, employeeId, workDate);
        return result('APPLIED');
      });
    } catch (err) {
      // The same item arrived concurrently from a retry: the other request recorded it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        return result('DUPLICATE');
      throw err;
    }
  }

  private async recordBatch(
    deviceId: string,
    results: ItemResult[],
    client: ClientInfo,
  ): Promise<void> {
    const count = (s: SyncItemStatus) => results.filter((r) => r.status === s).length;
    const counts = {
      itemCount: results.length,
      applied: count('APPLIED'),
      duplicates: count('DUPLICATE'),
      conflicts: count('CONFLICT'),
      rejected: count('REJECTED'),
      deferred: count('DEFERRED'),
    };
    const batch = await this.prisma.syncBatch.create({ data: { deviceId, ...counts } });
    await this.audit.record({
      actorUserId: null,
      action: 'kiosk.sync',
      entityType: 'sync_batch',
      entityId: batch.id,
      after: { deviceId, ...counts },
      client,
    });
    if (counts.rejected > 0)
      this.logger.warn(
        { deviceId, batchId: batch.id, rejected: counts.rejected },
        'Offline punches rejected during sync',
      );
  }
}
