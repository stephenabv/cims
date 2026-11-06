import { Injectable } from '@nestjs/common';
import {
  type MyOvertimeQuery,
  type OvertimeDecisionInput,
  type OvertimePolicy,
  type OvertimeQuery,
  type OvertimeRecordView,
  type OvertimeSummaryQuery,
  type OvertimeSummaryResult,
  type PaginatedResult,
  PERMISSIONS,
} from '@cims/shared';
import { Prisma } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { dateColumn, fromDateColumn } from '../attendance/domain/work-date';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';

const include = {
  employee: {
    select: {
      id: true,
      accountNumber: true,
      firstName: true,
      lastName: true,
      supervisorId: true,
      department: { select: { name: true, headId: true } },
    },
  },
  history: { orderBy: { actedAt: 'asc' } },
} satisfies Prisma.OvertimeRecordInclude;

type RecordRow = Prisma.OvertimeRecordGetPayload<{ include: typeof include }>;
type EmployeeRef = RecordRow['employee'];

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;

interface SummarySqlRow {
  id: string;
  account_number: string;
  first_name: string;
  last_name: string;
  department: string | null;
  days_worked: number;
  ot_approved: number;
  ot_pending: number;
  ot_rejected: number;
  ot_unrecorded: number;
  ut_days: number;
  ut_total: number;
  ut_counted: number;
  late: number;
  total_rows: number;
  sum_approved: number;
  sum_pending: number;
  sum_ut_counted: number;
  sum_late: number;
}

/**
 * Overtime approval and the overtime/undertime monitor (spec §3.4, §3.6, BR-13).
 *
 * Who sees and decides an employee's overtime: their direct supervisor, and holders of the
 * overtime permissions within their scope (all employees, or departments they head). Nobody
 * decides their own overtime. Decisions lock the record and check its `version`.
 */
@Injectable()
export class OvertimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ── Decisions ──────────────────────────────────────────────────────────────

  async decide(
    actor: AuthContext,
    id: string,
    input: OvertimeDecisionInput,
    client: ClientInfo,
  ): Promise<OvertimeRecordView> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM overtime_record WHERE id = ${id}::uuid FOR UPDATE`;
      const record = await tx.overtimeRecord.findUnique({ where: { id }, include });
      if (!record || !this.canView(actor, record.employee)) throw new NotFoundError('Overtime');
      if (!this.canDecide(actor, record.employee)) throw new NotFoundError('Overtime'); // own record: same answer as out of scope
      if (record.version !== input.version)
        throw new ConflictError('This overtime changed since you opened it. Reload and try again.');
      if (record.status === 'VOIDED')
        throw new ConflictError('This day no longer has overtime to decide');

      const approve = input.decision === 'APPROVE';
      const minutes = approve ? (input.approvedMinutes ?? record.actualMinutes) : null;
      if (minutes !== null && minutes > record.actualMinutes)
        throw new ValidationError([
          {
            path: 'approvedMinutes',
            message: `At most ${record.actualMinutes} minutes were worked`,
          },
        ]);
      if (approve && minutes! < record.actualMinutes && (input.note?.length ?? 0) < 3)
        throw new ValidationError([
          { path: 'note', message: 'Explain why only part of the overtime is approved' },
        ]);

      const status = approve ? 'APPROVED' : 'REJECTED';
      await tx.overtimeRecord.update({
        where: { id },
        data: { status, approvedMinutes: minutes, version: { increment: 1 } },
      });
      await tx.overtimeHistory.create({
        data: {
          recordId: id,
          action: input.decision,
          minutes,
          note: input.note || null,
          actedById: actor.userId,
          actedAt: this.clock.now(),
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: approve ? 'overtime.approve' : 'overtime.reject',
          entityType: 'overtime_record',
          entityId: id,
          before: { status: record.status, approvedMinutes: record.approvedMinutes },
          after: { status, approvedMinutes: minutes, note: input.note ?? null },
          client,
        },
        tx,
      );
    });
    return this.get(actor, id);
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async get(actor: AuthContext, id: string): Promise<OvertimeRecordView> {
    const record = await this.prisma.overtimeRecord.findUnique({ where: { id }, include });
    if (!record || !this.canView(actor, record.employee)) throw new NotFoundError('Overtime');
    return (await this.views(actor, [record]))[0]!;
  }

  async mine(actor: AuthContext, q: MyOvertimeQuery): Promise<PaginatedResult<OvertimeRecordView>> {
    return this.page(
      actor,
      {
        employeeId: actor.employeeId,
        workDate: { gte: dateColumn(q.from), lte: dateColumn(q.to) },
      },
      q,
      'desc',
    );
  }

  /** Other people's overtime the actor may see; pending items oldest first for review. */
  async list(actor: AuthContext, q: OvertimeQuery): Promise<PaginatedResult<OvertimeRecordView>> {
    const where: Prisma.OvertimeRecordWhereInput = {
      AND: [
        this.scopeWhere(actor),
        { employeeId: { not: actor.employeeId } },
        q.employeeId ? { employeeId: q.employeeId } : {},
        q.departmentId ? { employee: { departmentId: q.departmentId } } : {},
        q.status ? { status: q.status } : {},
        q.from || q.to
          ? {
              workDate: {
                ...(q.from ? { gte: dateColumn(q.from) } : {}),
                ...(q.to ? { lte: dateColumn(q.to) } : {}),
              },
            }
          : {},
      ],
    };
    return this.page(actor, where, q, q.status === 'PENDING' ? 'asc' : 'desc');
  }

  /** Records the actor can decide right now (for the "waiting for you" prompt). */
  async waitingCount(actor: AuthContext): Promise<number> {
    const records = await this.prisma.overtimeRecord.findMany({
      where: {
        AND: [
          this.scopeWhere(actor),
          { status: 'PENDING' },
          { employeeId: { not: actor.employeeId } },
        ],
      },
      select: { employee: include.employee },
    });
    return records.filter((r) => this.canDecide(actor, r.employee)).length;
  }

  /**
   * Per-employee overtime and undertime totals for a range: a day (daily summary) or a month
   * (monthly report). Undertime below the company threshold is shown but not counted.
   */
  async summary(actor: AuthContext, q: OvertimeSummaryQuery): Promise<OvertimeSummaryResult> {
    const policy = await this.policy();
    const from = dateColumn(q.from);
    const to = dateColumn(q.to);
    const viewAll = actor.permissions.has(PERMISSIONS.OVERTIME_VIEW_ALL);
    const byDepartment = actor.permissions.has(PERMISSIONS.OVERTIME_VIEW_DEPARTMENT);
    const scope = viewAll
      ? Prisma.sql`TRUE`
      : Prisma.sql`e.id <> ${actor.employeeId}::uuid AND (e.supervisor_id = ${actor.employeeId}::uuid
          ${byDepartment ? Prisma.sql`OR d.head_id = ${actor.employeeId}::uuid` : Prisma.empty})`;
    const department = q.departmentId
      ? Prisma.sql`AND e.department_id = ${q.departmentId}::uuid`
      : Prisma.empty;
    const threshold = policy.undertimeThresholdMinutes;

    const rows = await this.prisma.$queryRaw<SummarySqlRow[]>`
      WITH days AS (
        SELECT a.employee_id,
          count(*)::int AS days_worked,
          count(*) FILTER (WHERE a.undertime_minutes > 0)::int AS ut_days,
          coalesce(sum(a.undertime_minutes), 0)::int AS ut_total,
          coalesce(sum(a.undertime_minutes) FILTER (
            WHERE a.undertime_minutes > 0 AND a.undertime_minutes >= ${threshold}), 0)::int AS ut_counted,
          coalesce(sum(a.late_minutes), 0)::int AS late,
          coalesce(sum(a.overtime_minutes) FILTER (
            WHERE (r.id IS NULL OR r.status = 'VOIDED')
              AND a.status <> 'INCOMPLETE' AND NOT a.has_open_punch), 0)::int AS ot_unrecorded
        FROM attendance_day a
        LEFT JOIN overtime_record r ON r.employee_id = a.employee_id AND r.work_date = a.work_date
        WHERE a.work_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY a.employee_id
      ), ot AS (
        SELECT employee_id,
          coalesce(sum(approved_minutes) FILTER (WHERE status = 'APPROVED'), 0)::int AS ot_approved,
          coalesce(sum(actual_minutes) FILTER (WHERE status = 'PENDING'), 0)::int AS ot_pending,
          coalesce(sum(actual_minutes) FILTER (WHERE status = 'REJECTED'), 0)::int AS ot_rejected
        FROM overtime_record
        WHERE work_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY employee_id
      ), rows AS (
        SELECT e.id, e.account_number, e.first_name, e.last_name, d.name AS department,
          coalesce(days.days_worked, 0) AS days_worked,
          coalesce(ot.ot_approved, 0) AS ot_approved,
          coalesce(ot.ot_pending, 0) AS ot_pending,
          coalesce(ot.ot_rejected, 0) AS ot_rejected,
          coalesce(days.ot_unrecorded, 0) AS ot_unrecorded,
          coalesce(days.ut_days, 0) AS ut_days,
          coalesce(days.ut_total, 0) AS ut_total,
          coalesce(days.ut_counted, 0) AS ut_counted,
          coalesce(days.late, 0) AS late
        FROM employee e
        LEFT JOIN department d ON d.id = e.department_id
        LEFT JOIN days ON days.employee_id = e.id
        LEFT JOIN ot ON ot.employee_id = e.id
        WHERE (days.employee_id IS NOT NULL OR ot.employee_id IS NOT NULL)
          AND ${scope} ${department}
      )
      SELECT rows.*,
        (count(*) OVER ())::int AS total_rows,
        (sum(ot_approved) OVER ())::int AS sum_approved,
        (sum(ot_pending) OVER ())::int AS sum_pending,
        (sum(ut_counted) OVER ())::int AS sum_ut_counted,
        (sum(late) OVER ())::int AS sum_late
      FROM rows
      ORDER BY last_name, first_name, id
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;

    const first = rows[0];
    return {
      data: rows.map((r) => ({
        employee: {
          id: r.id,
          accountNumber: r.account_number,
          fullName: fullName({ firstName: r.first_name, lastName: r.last_name }),
          department: r.department,
        },
        daysWorked: r.days_worked,
        overtime: {
          approvedMinutes: r.ot_approved,
          pendingMinutes: r.ot_pending,
          rejectedMinutes: r.ot_rejected,
          unrecordedMinutes: r.ot_unrecorded,
        },
        undertime: { days: r.ut_days, totalMinutes: r.ut_total, countedMinutes: r.ut_counted },
        lateMinutes: r.late,
      })),
      meta: { page: q.page, pageSize: q.pageSize, total: first?.total_rows ?? 0 },
      totals: {
        approvedMinutes: first?.sum_approved ?? 0,
        pendingMinutes: first?.sum_pending ?? 0,
        undertimeCountedMinutes: first?.sum_ut_counted ?? 0,
        lateMinutes: first?.sum_late ?? 0,
      },
      policy,
    };
  }

  // ── Policy ─────────────────────────────────────────────────────────────────

  async policy(): Promise<OvertimePolicy> {
    const s = await this.settings.getMany([
      'overtime.minimumMinutes',
      'undertime.thresholdMinutes',
    ]);
    return {
      overtimeMinimumMinutes: s['overtime.minimumMinutes'],
      undertimeThresholdMinutes: s['undertime.thresholdMinutes'],
    };
  }

  /** Applies to attendance recomputed from now on; existing records keep their figures. */
  async setPolicy(actor: AuthContext, input: OvertimePolicy): Promise<OvertimePolicy> {
    await this.settings.setMany(
      {
        'overtime.minimumMinutes': input.overtimeMinimumMinutes,
        'undertime.thresholdMinutes': input.undertimeThresholdMinutes,
      },
      actor.userId,
    );
    return this.policy();
  }

  // ── Access rules ───────────────────────────────────────────────────────────

  private inPermissionScope(actor: AuthContext, e: EmployeeRef): boolean {
    if (actor.permissions.has(PERMISSIONS.OVERTIME_VIEW_ALL)) return true;
    return (
      actor.permissions.has(PERMISSIONS.OVERTIME_VIEW_DEPARTMENT) &&
      e.department?.headId === actor.employeeId
    );
  }

  private canView(actor: AuthContext, e: EmployeeRef): boolean {
    return (
      e.id === actor.employeeId ||
      e.supervisorId === actor.employeeId ||
      this.inPermissionScope(actor, e)
    );
  }

  /** The direct supervisor, or an overtime approver within scope; never the employee. */
  private canDecide(actor: AuthContext, e: EmployeeRef): boolean {
    if (e.id === actor.employeeId) return false;
    if (e.supervisorId === actor.employeeId) return true;
    return actor.permissions.has(PERMISSIONS.OVERTIME_APPROVE) && this.inPermissionScope(actor, e);
  }

  /** Prisma filter matching {@link canView} for other people's records. */
  private scopeWhere(actor: AuthContext): Prisma.OvertimeRecordWhereInput {
    if (actor.permissions.has(PERMISSIONS.OVERTIME_VIEW_ALL)) return {};
    const or: Prisma.OvertimeRecordWhereInput[] = [
      { employee: { supervisorId: actor.employeeId } },
    ];
    if (actor.permissions.has(PERMISSIONS.OVERTIME_VIEW_DEPARTMENT))
      or.push({ employee: { department: { headId: actor.employeeId } } });
    return { OR: or };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async page(
    actor: AuthContext,
    where: Prisma.OvertimeRecordWhereInput,
    q: { page: number; pageSize: number },
    order: 'asc' | 'desc',
  ): Promise<PaginatedResult<OvertimeRecordView>> {
    const [rows, total] = await Promise.all([
      this.prisma.overtimeRecord.findMany({
        where,
        include,
        orderBy: [{ workDate: order }, { employee: { lastName: 'asc' } }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.overtimeRecord.count({ where }),
    ]);
    return {
      data: await this.views(actor, rows),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  }

  private async views(actor: AuthContext, rows: RecordRow[]): Promise<OvertimeRecordView[]> {
    const userIds = [
      ...new Set(rows.flatMap((r) => r.history.map((h) => h.actedById)).filter((x) => !!x)),
    ] as string[];
    const [users, days] = await Promise.all([
      this.prisma.userAccount.findMany({
        where: { id: { in: userIds } },
        select: { id: true, employee: { select: { firstName: true, lastName: true } } },
      }),
      this.prisma.attendanceDay.findMany({
        where: {
          OR: rows.map((r) => ({ employeeId: r.employeeId, workDate: r.workDate })),
        },
        select: { employeeId: true, workDate: true, firstIn: true, lastOut: true },
      }),
    ]);
    const names = new Map(users.map((u) => [u.id, fullName(u.employee)]));
    const punches = new Map(
      days.map((d) => [`${d.employeeId}|${fromDateColumn(d.workDate)}`, d] as const),
    );
    return rows.map((r) => {
      const day = punches.get(`${r.employeeId}|${fromDateColumn(r.workDate)}`);
      return {
        id: r.id,
        version: r.version,
        status: r.status,
        employee: {
          id: r.employee.id,
          accountNumber: r.employee.accountNumber,
          fullName: fullName(r.employee),
          department: r.employee.department?.name ?? null,
        },
        workDate: fromDateColumn(r.workDate),
        firstIn: day?.firstIn?.toISOString() ?? null,
        lastOut: day?.lastOut?.toISOString() ?? null,
        actualMinutes: r.actualMinutes,
        approvedMinutes: r.approvedMinutes,
        history: r.history.map((h) => ({
          action: h.action,
          minutes: h.minutes,
          note: h.note,
          actedBy: h.actedById ? (names.get(h.actedById) ?? null) : null,
          actedAt: h.actedAt.toISOString(),
        })),
        can: { decide: r.status !== 'VOIDED' && this.canDecide(actor, r.employee) },
      };
    });
  }
}
