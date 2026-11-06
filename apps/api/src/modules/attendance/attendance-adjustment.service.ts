import { Injectable } from '@nestjs/common';
import type { AddPunchInput, VoidPunchInput } from '@cims/shared';
import type { Prisma } from '@prisma/client';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { AttendanceDayService } from './attendance-day.service';
import { AttendanceQueryService } from './attendance-query.service';
import { dateColumn, fromDateColumn, instantAt } from './domain/work-date';

/**
 * HR corrections to attendance (spec §4). Punches are never edited or deleted: a wrong punch is
 * voided (kept, excluded from computation) and a missing one is added with source ADJUSTMENT.
 * Every change needs a reason, recomputes the affected day and is audit-logged in the same
 * transaction. Changes run under the employee row lock shared with kiosk punches and sync.
 */
@Injectable()
export class AttendanceAdjustmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly query: AttendanceQueryService,
    private readonly settings: SettingsService,
    private readonly days: AttendanceDayService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async addPunch(
    actor: AuthContext,
    employeeId: string,
    input: AddPunchInput,
    client: ClientInfo,
  ): Promise<{ id: string; workDate: string }> {
    this.assertNotSelf(actor, employeeId);
    await this.query.assertCanViewEmployee(actor, employeeId);
    const now = this.clock.now();
    const s = await this.settings.getMany([
      'company.timezone',
      'attendance.duplicateWindowSeconds',
    ] as const);
    const [h, m] = input.time.split(':').map(Number) as [number, number];
    const at = instantAt(input.date, h * 60 + m, s['company.timezone']);
    if (at > now)
      throw new ValidationError([{ path: 'time', message: 'A punch cannot be in the future' }]);

    return this.prisma.$transaction(async (tx) => {
      await this.lockEmployee(tx, employeeId);
      const windowMs = s['attendance.duplicateWindowSeconds'] * 1000;
      const near = await tx.attendanceEvent.findFirst({
        where: {
          employeeId,
          type: input.type,
          status: 'ACCEPTED',
          occurredAt: {
            gt: new Date(at.getTime() - windowMs),
            lt: new Date(at.getTime() + windowMs),
          },
        },
        select: { id: true },
      });
      if (near) throw new ConflictError('A matching punch already exists at this time');

      // A time-out belongs to the work date of the time-in it closes (overnight shifts).
      const previous = await tx.attendanceEvent.findFirst({
        where: { employeeId, status: 'ACCEPTED', occurredAt: { lt: at } },
        orderBy: { occurredAt: 'desc' },
        select: { type: true, workDate: true },
      });
      const workDate =
        input.type === 'TIME_OUT' && previous?.type === 'TIME_IN'
          ? fromDateColumn(previous.workDate)
          : input.date;

      const event = await tx.attendanceEvent.create({
        data: {
          employeeId,
          type: input.type,
          occurredAt: at,
          recordedAt: now,
          workDate: dateColumn(workDate),
          source: 'ADJUSTMENT',
          status: 'ACCEPTED',
          createdById: actor.userId,
          note: input.reason,
        },
      });
      await this.days.recompute(tx, employeeId, workDate);
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'attendance.punch.add',
          entityType: 'attendance_event',
          entityId: event.id,
          after: {
            employeeId,
            type: input.type,
            occurredAt: at.toISOString(),
            workDate,
            reason: input.reason,
          },
          client,
        },
        tx,
      );
      return { id: event.id, workDate };
    });
  }

  async voidPunch(
    actor: AuthContext,
    eventId: string,
    input: VoidPunchInput,
    client: ClientInfo,
  ): Promise<void> {
    const event = await this.prisma.attendanceEvent.findUnique({
      where: { id: eventId },
      select: { employeeId: true },
    });
    if (!event) throw new NotFoundError('Punch');
    this.assertNotSelf(actor, event.employeeId);
    // Out-of-scope punches are reported as missing so their existence is not disclosed.
    await this.query.assertCanViewEmployee(actor, event.employeeId).catch(() => {
      throw new NotFoundError('Punch');
    });
    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      await this.lockEmployee(tx, event.employeeId);
      // Guarded update: only an accepted punch can be voided, and only once. Offline conflicts
      // are decided on the conflicts screen instead.
      const updated = await tx.attendanceEvent.updateMany({
        where: { id: eventId, status: 'ACCEPTED' },
        data: {
          status: 'VOIDED',
          voidedById: actor.userId,
          voidedAt: now,
          voidReason: input.reason,
        },
      });
      if (updated.count === 0) throw new ConflictError('Only an accepted punch can be voided');
      const row = await tx.attendanceEvent.findUniqueOrThrow({
        where: { id: eventId },
        select: { type: true, occurredAt: true, workDate: true },
      });
      const workDate = fromDateColumn(row.workDate);
      await this.days.recompute(tx, event.employeeId, workDate);
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'attendance.punch.void',
          entityType: 'attendance_event',
          entityId: eventId,
          before: { status: 'ACCEPTED' },
          after: {
            status: 'VOIDED',
            employeeId: event.employeeId,
            type: row.type,
            occurredAt: row.occurredAt.toISOString(),
            workDate,
            reason: input.reason,
          },
          client,
        },
        tx,
      );
    });
  }

  /** Separation of duties: nobody corrects their own attendance. */
  private assertNotSelf(actor: AuthContext, employeeId: string): void {
    if (actor.employeeId === employeeId)
      throw new ForbiddenError('You cannot change your own attendance. Ask another HR user.');
  }

  private async lockEmployee(tx: Prisma.TransactionClient, employeeId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM employee WHERE id = ${employeeId}::uuid FOR UPDATE`;
  }
}
