import { Injectable } from '@nestjs/common';
import type {
  AttendanceConflictQuery,
  AttendanceConflictView,
  PaginatedResult,
  ResolveConflictInput,
} from '@cims/shared';
import type { Prisma } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AttendanceDayService } from './attendance-day.service';
import { fromDateColumn } from './domain/work-date';

const include = {
  employee: { select: { id: true, accountNumber: true, firstName: true, lastName: true } },
  event: {
    select: { type: true, occurredAt: true, workDate: true, device: { select: { name: true } } },
  },
} satisfies Prisma.AttendanceConflictInclude;

type ConflictRow = Prisma.AttendanceConflictGetPayload<{ include: typeof include }>;

/** HR review of offline punches that contradicted existing records (spec §4). */
@Injectable()
export class AttendanceConflictService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly days: AttendanceDayService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(q: AttendanceConflictQuery): Promise<PaginatedResult<AttendanceConflictView>> {
    const where = { status: q.status };
    const [rows, total] = await Promise.all([
      this.prisma.attendanceConflict.findMany({
        where,
        include,
        orderBy: { createdAt: q.status === 'OPEN' ? 'asc' : 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.attendanceConflict.count({ where }),
    ]);
    const resolverIds = [
      ...new Set(rows.map((r) => r.resolvedById).filter((id): id is string => !!id)),
    ];
    const resolvers = await this.prisma.userAccount.findMany({
      where: { id: { in: resolverIds } },
      select: { id: true, employee: { select: { firstName: true, lastName: true } } },
    });
    const names = new Map(
      resolvers.map((r) => [r.id, `${r.employee.firstName} ${r.employee.lastName}`]),
    );
    return {
      data: rows.map((r) => this.view(r, names)),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  }

  /**
   * Accepting puts the punch into the employee's record; rejecting voids it. Either way the
   * original punch is kept, and the decision is final.
   */
  async resolve(
    actor: AuthContext,
    id: string,
    input: ResolveConflictInput,
    client: ClientInfo,
  ): Promise<void> {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const conflict = await tx.attendanceConflict.findUnique({
        where: { id },
        include: { event: true },
      });
      if (!conflict) throw new NotFoundError('Conflict');
      await tx.$queryRaw`SELECT id FROM employee WHERE id = ${conflict.employeeId}::uuid FOR UPDATE`;

      const status = input.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
      // Guarded update: two reviewers acting at once cannot both resolve it.
      const updated = await tx.attendanceConflict.updateMany({
        where: { id, status: 'OPEN' },
        data: { status, resolvedById: actor.userId, resolvedAt: now, resolutionNote: input.note },
      });
      if (updated.count === 0) throw new ConflictError('This conflict has already been resolved');

      await tx.attendanceEvent.update({
        where: { id: conflict.eventId },
        data:
          input.decision === 'ACCEPT'
            ? { status: 'ACCEPTED', note: input.note }
            : { status: 'VOIDED', voidedById: actor.userId, voidedAt: now, voidReason: input.note },
      });
      await this.days.recompute(tx, conflict.employeeId, fromDateColumn(conflict.event.workDate));
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: `attendance.conflict.${input.decision.toLowerCase()}`,
          entityType: 'attendance_conflict',
          entityId: id,
          before: { status: 'OPEN' },
          after: { status, note: input.note, eventId: conflict.eventId },
          client,
        },
        tx,
      );
    });
  }

  private view(r: ConflictRow, names: Map<string, string>): AttendanceConflictView {
    return {
      id: r.id,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      employee: {
        id: r.employee.id,
        accountNumber: r.employee.accountNumber,
        fullName: `${r.employee.firstName} ${r.employee.lastName}`,
      },
      punch: {
        type: r.event.type,
        occurredAt: r.event.occurredAt.toISOString(),
        workDate: fromDateColumn(r.event.workDate),
        device: r.event.device?.name ?? null,
      },
      resolution: r.resolvedAt
        ? {
            by: r.resolvedById ? (names.get(r.resolvedById) ?? null) : null,
            at: r.resolvedAt.toISOString(),
            note: r.resolutionNote ?? '',
          }
        : null,
    };
  }
}
