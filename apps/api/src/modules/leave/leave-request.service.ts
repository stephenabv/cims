import { Injectable } from '@nestjs/common';
import {
  type ApplyLeaveInput,
  type CancelLeaveInput,
  type LeaveDecisionInput,
  type LeavePreview,
  type LeavePreviewInput,
  type LeaveRequestQuery,
  type LeaveRequestView,
  type MyLeaveQuery,
  type PaginatedResult,
  PERMISSIONS,
  SYSTEM_ROLES,
  type WithdrawLeaveInput,
} from '@cims/shared';
import { Prisma } from '@prisma/client';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { addDays, dateColumn, fromDateColumn, workDateOf } from '../attendance/domain/work-date';
import { ScheduleService } from '../attendance/schedule.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { resolveApprovalSteps } from './domain/approval-chain';
import { countLeaveDates, daysByYear } from './domain/leave-days';

/** Leave may be filed after the fact (e.g. sick leave) up to this many days back. */
const MAX_PAST_DAYS = 60;
/** …and at most this far ahead. */
const MAX_FUTURE_DAYS = 366;

const include = {
  employee: { select: { id: true, accountNumber: true, firstName: true, lastName: true } },
  leaveType: { select: { id: true, code: true, name: true, isPaid: true } },
  steps: {
    orderBy: { position: 'asc' },
    include: {
      approverEmployee: { select: { firstName: true, lastName: true } },
      approverRole: { select: { key: true, name: true } },
    },
  },
} satisfies Prisma.LeaveRequestInclude;

type RequestRow = Prisma.LeaveRequestGetPayload<{ include: typeof include }>;
type StepRow = RequestRow['steps'][number];

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;
const ACTIVE: Prisma.EnumLeaveRequestStatusFilter = { in: ['PENDING', 'APPROVED'] };

/**
 * Leave requests and their approval workflow (spec §3.3, BR-10, BR-11, assumptions A-4, A-5).
 *
 * Every state change runs in a transaction that locks the request row and checks the client's
 * `version`, so two approvers (or an approver and the applicant) cannot both act on the same
 * state. Filing locks the employee row so two overlapping requests cannot both be accepted; a
 * database exclusion constraint backs this up.
 */
@Injectable()
export class LeaveRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: ScheduleService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ── Filing ─────────────────────────────────────────────────────────────────

  async preview(actor: AuthContext, input: LeavePreviewInput): Promise<LeavePreview> {
    await this.activeType(input.leaveTypeId);
    const dates = await this.workingDates(actor.employeeId, input.startDate, input.endDate);
    return { days: dates.length, dates };
  }

  async apply(
    actor: AuthContext,
    input: ApplyLeaveInput,
    client: ClientInfo,
  ): Promise<LeaveRequestView> {
    const type = await this.activeType(input.leaveTypeId);
    const today = await this.today();
    if (input.startDate < addDays(today, -MAX_PAST_DAYS))
      throw new ValidationError([
        {
          path: 'startDate',
          message: `Leave can be filed up to ${MAX_PAST_DAYS} days after it starts`,
        },
      ]);
    if (input.endDate > addDays(today, MAX_FUTURE_DAYS))
      throw new ValidationError([
        { path: 'endDate', message: 'Leave can be filed up to a year ahead' },
      ]);
    const { dateHired } = await this.prisma.employee.findUniqueOrThrow({
      where: { id: actor.employeeId },
      select: { dateHired: true },
    });
    if (input.startDate < fromDateColumn(dateHired))
      throw new ValidationError([
        { path: 'startDate', message: 'Leave cannot start before your hire date' },
      ]);
    const dates = await this.workingDates(actor.employeeId, input.startDate, input.endDate);
    if (dates.length === 0)
      throw new ValidationError([
        { path: 'endDate', message: 'There are no working days in this range' },
      ]);

    const hr = await this.prisma.role.findUniqueOrThrow({ where: { key: SYSTEM_ROLES.HR } });
    const chain = await this.prisma.approvalChain.findFirst({
      where: type.approvalChainId ? { id: type.approvalChainId } : { isDefault: true },
      include: { steps: { orderBy: { position: 'asc' } } },
    });

    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM employee WHERE id = ${actor.employeeId}::uuid FOR UPDATE`;
        const overlap = await tx.leaveRequest.findFirst({
          where: {
            employeeId: actor.employeeId,
            status: ACTIVE,
            startDate: { lte: dateColumn(input.endDate) },
            endDate: { gte: dateColumn(input.startDate) },
          },
          select: { startDate: true, endDate: true },
        });
        if (overlap) throw this.overlapError(overlap);
        await this.assertBalance(tx, actor.employeeId, type, dates);

        const applicant = await tx.employee.findUniqueOrThrow({
          where: { id: actor.employeeId },
          select: { supervisorId: true, department: { select: { headId: true } } },
        });
        const resolved = resolveApprovalSteps(
          chain?.steps ?? [],
          {
            employeeId: actor.employeeId,
            supervisorId: applicant.supervisorId,
            departmentHeadId: applicant.department?.headId ?? null,
          },
          hr.id,
        );
        let first = true;
        const request = await tx.leaveRequest.create({
          data: {
            employeeId: actor.employeeId,
            leaveTypeId: type.id,
            startDate: dateColumn(input.startDate),
            endDate: dateColumn(input.endDate),
            days: dates.length,
            reason: input.reason,
            submittedAt: this.clock.now(),
            steps: {
              create: resolved.map((s, i) => {
                if (s.status === 'SKIPPED')
                  return {
                    position: i + 1,
                    kind: s.kind,
                    status: 'SKIPPED' as const,
                    note: s.reason,
                  };
                const status = first ? ('PENDING' as const) : ('WAITING' as const);
                first = false;
                return {
                  position: i + 1,
                  kind: s.kind,
                  status,
                  approverEmployeeId: s.approverEmployeeId,
                  approverRoleId: s.approverRoleId,
                };
              }),
            },
            leaveDays: {
              create: dates.map((d) => ({ employeeId: actor.employeeId, date: dateColumn(d) })),
            },
          },
        });
        await this.audit.record(
          {
            actorUserId: actor.userId,
            action: 'leave.request.submit',
            entityType: 'leave_request',
            entityId: request.id,
            after: {
              leaveType: type.code,
              startDate: input.startDate,
              endDate: input.endDate,
              days: dates.length,
            },
            client,
          },
          tx,
        );
        return request.id;
      });
      return this.get(actor, id);
    } catch (err) {
      // The exclusion constraint caught an overlap the application check could not see.
      if (String((err as Error).message).includes('leave_request_no_overlap'))
        throw new ConflictError('These dates overlap another leave request');
      throw err;
    }
  }

  // ── Decisions ──────────────────────────────────────────────────────────────

  async decide(
    actor: AuthContext,
    id: string,
    input: LeaveDecisionInput,
    client: ClientInfo,
  ): Promise<LeaveRequestView> {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const request = await this.lockForChange(tx, actor, id, input.version);
      if (request.status !== 'PENDING')
        throw new ConflictError('This request has already been decided');
      const current = request.steps.find((s) => s.status === 'PENDING');
      if (!current || !this.canActOn(actor, request, current))
        throw new ForbiddenError('You are not the approver for the current step of this request');

      const approve = input.decision === 'APPROVE';
      await tx.leaveApprovalStep.update({
        where: { id: current.id },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          actedById: actor.userId,
          actedAt: now,
          note: input.note || null,
        },
      });
      const next = approve ? request.steps.find((s) => s.status === 'WAITING') : undefined;
      if (next) {
        await tx.leaveApprovalStep.update({ where: { id: next.id }, data: { status: 'PENDING' } });
      } else if (!approve) {
        await tx.leaveApprovalStep.updateMany({
          where: { requestId: id, status: 'WAITING' },
          data: { status: 'CANCELLED' },
        });
      }
      const status = !approve ? 'REJECTED' : next ? 'PENDING' : 'APPROVED';
      await tx.leaveRequest.update({
        where: { id },
        data: {
          status,
          version: { increment: 1 },
          ...(status === 'PENDING' ? {} : { decidedAt: now }),
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: approve ? 'leave.request.approve_step' : 'leave.request.reject',
          entityType: 'leave_request',
          entityId: id,
          before: { status: 'PENDING', step: current.position },
          after: { status, step: current.position, note: input.note ?? null },
          client,
        },
        tx,
      );
    });
    return this.get(actor, id);
  }

  /** The applicant pulls back a request no approver has acted on yet (A-4). */
  async withdraw(
    actor: AuthContext,
    id: string,
    input: WithdrawLeaveInput,
    client: ClientInfo,
  ): Promise<LeaveRequestView> {
    await this.prisma.$transaction(async (tx) => {
      const request = await this.lockForChange(tx, actor, id, input.version);
      if (request.employeeId !== actor.employeeId) throw new NotFoundError('Leave request');
      if (!this.withdrawable(request))
        throw new ConflictError(
          request.status === 'PENDING'
            ? 'An approver has already acted on this request. Ask HR to cancel it.'
            : 'Only a pending request can be withdrawn',
        );
      await this.end(tx, actor, request, 'WITHDRAWN', null, client);
    });
    return this.get(actor, id);
  }

  /** HR cancels a pending request, or an approved one that has not started (A-4). */
  async cancel(
    actor: AuthContext,
    id: string,
    input: CancelLeaveInput,
    client: ClientInfo,
  ): Promise<LeaveRequestView> {
    const today = await this.today();
    await this.prisma.$transaction(async (tx) => {
      const request = await this.lockForChange(tx, actor, id, input.version);
      if (request.employeeId === actor.employeeId)
        throw new ForbiddenError(
          'Withdraw your own requests, or ask another HR user to cancel them',
        );
      if (!this.cancellable(request, today))
        throw new ConflictError(
          'Only pending requests, or approved leave that has not started, can be cancelled',
        );
      await this.end(tx, actor, request, 'CANCELLED', input.reason, client);
    });
    return this.get(actor, id);
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async get(actor: AuthContext, id: string): Promise<LeaveRequestView> {
    const row = await this.prisma.leaveRequest.findUnique({ where: { id }, include });
    if (!row || !(await this.canView(actor, row))) throw new NotFoundError('Leave request');
    return (await this.views(actor, [row]))[0]!;
  }

  async mine(actor: AuthContext, q: MyLeaveQuery): Promise<PaginatedResult<LeaveRequestView>> {
    return this.page(actor, { employeeId: actor.employeeId, status: q.status }, q, 'desc');
  }

  /** Requests whose current step the actor can decide. */
  async approvals(
    actor: AuthContext,
    q: { page: number; pageSize: number },
  ): Promise<PaginatedResult<LeaveRequestView>> {
    const where: Prisma.LeaveRequestWhereInput = {
      status: 'PENDING',
      employeeId: { not: actor.employeeId },
      steps: { some: { status: 'PENDING', OR: this.approverFilter(actor) } },
    };
    return this.page(actor, where, q, 'asc');
  }

  /** HR / managers: everyone's requests, or those of departments the viewer heads. */
  async list(actor: AuthContext, q: LeaveRequestQuery): Promise<PaginatedResult<LeaveRequestView>> {
    const where: Prisma.LeaveRequestWhereInput = {
      status: q.status,
      employeeId: q.employeeId,
      ...(q.from ? { endDate: { gte: dateColumn(q.from) } } : {}),
      ...(q.to ? { startDate: { lte: dateColumn(q.to) } } : {}),
    };
    if (!actor.permissions.has(PERMISSIONS.LEAVE_VIEW_ALL)) {
      if (!actor.permissions.has(PERMISSIONS.LEAVE_VIEW_DEPARTMENT)) throw new ForbiddenError();
      where.employee = { department: { headId: actor.employeeId } };
    }
    return this.page(actor, where, q, 'desc');
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async page(
    actor: AuthContext,
    where: Prisma.LeaveRequestWhereInput,
    q: { page: number; pageSize: number },
    order: 'asc' | 'desc',
  ): Promise<PaginatedResult<LeaveRequestView>> {
    const [rows, total] = await Promise.all([
      this.prisma.leaveRequest.findMany({
        where,
        include,
        orderBy: [{ startDate: order }, { submittedAt: order }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);
    return {
      data: await this.views(actor, rows),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  }

  private async lockForChange(
    tx: PrismaTx,
    actor: AuthContext,
    id: string,
    version: number,
  ): Promise<RequestRow> {
    await tx.$queryRaw`SELECT id FROM leave_request WHERE id = ${id}::uuid FOR UPDATE`;
    const request = await tx.leaveRequest.findUnique({ where: { id }, include });
    if (!request || !(await this.canView(actor, request, tx)))
      throw new NotFoundError('Leave request');
    if (request.version !== version)
      throw new ConflictError('This request was changed by someone else. Reload it and try again.');
    return request;
  }

  private async end(
    tx: PrismaTx,
    actor: AuthContext,
    request: RequestRow,
    status: 'WITHDRAWN' | 'CANCELLED',
    reason: string | null,
    client: ClientInfo,
  ): Promise<void> {
    const now = this.clock.now();
    await tx.leaveApprovalStep.updateMany({
      where: { requestId: request.id, status: { in: ['PENDING', 'WAITING'] } },
      data: { status: 'CANCELLED' },
    });
    await tx.leaveRequest.update({
      where: { id: request.id },
      data: {
        status,
        version: { increment: 1 },
        decidedAt: now,
        endedById: actor.userId,
        endReason: reason,
      },
    });
    await this.audit.record(
      {
        actorUserId: actor.userId,
        action: status === 'WITHDRAWN' ? 'leave.request.withdraw' : 'leave.request.cancel',
        entityType: 'leave_request',
        entityId: request.id,
        before: { status: request.status },
        after: { status, reason },
        client,
      },
      tx,
    );
  }

  private approverFilter(actor: AuthContext): Prisma.LeaveApprovalStepWhereInput[] {
    const filters: Prisma.LeaveApprovalStepWhereInput[] = [
      { approverEmployeeId: actor.employeeId },
    ];
    if (actor.permissions.has(PERMISSIONS.LEAVE_APPROVE))
      filters.push({ approverRole: { key: actor.roleKey } });
    return filters;
  }

  private canActOn(actor: AuthContext, request: RequestRow, step: StepRow): boolean {
    if (request.employeeId === actor.employeeId) return false;
    if (step.approverEmployeeId) return step.approverEmployeeId === actor.employeeId;
    return (
      step.approverRole?.key === actor.roleKey && actor.permissions.has(PERMISSIONS.LEAVE_APPROVE)
    );
  }

  private withdrawable(r: RequestRow): boolean {
    return r.status === 'PENDING' && !r.steps.some((s) => s.status === 'APPROVED');
  }

  private cancellable(r: RequestRow, today: string): boolean {
    return (
      r.status === 'PENDING' || (r.status === 'APPROVED' && fromDateColumn(r.startDate) > today)
    );
  }

  /** Owner, anyone on its approval chain, or a viewer with leave visibility over the employee. */
  private async canView(
    actor: AuthContext,
    r: RequestRow,
    tx: PrismaTx = this.prisma,
  ): Promise<boolean> {
    if (r.employeeId === actor.employeeId) return true;
    if (r.steps.some((s) => s.approverEmployeeId === actor.employeeId)) return true;
    if (
      actor.permissions.has(PERMISSIONS.LEAVE_APPROVE) &&
      r.steps.some((s) => s.approverRole?.key === actor.roleKey)
    )
      return true;
    if (actor.permissions.has(PERMISSIONS.LEAVE_VIEW_ALL)) return true;
    if (actor.permissions.has(PERMISSIONS.LEAVE_VIEW_DEPARTMENT)) {
      const e = await tx.employee.findUnique({
        where: { id: r.employeeId },
        select: { department: { select: { headId: true } } },
      });
      return e?.department?.headId === actor.employeeId;
    }
    return false;
  }

  private async views(actor: AuthContext, rows: RequestRow[]): Promise<LeaveRequestView[]> {
    const userIds = [
      ...new Set(
        rows
          .flatMap((r) => [...r.steps.map((s) => s.actedById), r.endedById])
          .filter((x): x is string => !!x),
      ),
    ];
    const users = await this.prisma.userAccount.findMany({
      where: { id: { in: userIds } },
      select: { id: true, employee: { select: { firstName: true, lastName: true } } },
    });
    const names = new Map(users.map((u) => [u.id, fullName(u.employee)]));
    const today = await this.today();
    return rows.map((r) => {
      const current = r.steps.find((s) => s.status === 'PENDING');
      const own = r.employeeId === actor.employeeId;
      return {
        id: r.id,
        version: r.version,
        status: r.status,
        employee: {
          id: r.employee.id,
          accountNumber: r.employee.accountNumber,
          fullName: fullName(r.employee),
        },
        leaveType: r.leaveType,
        startDate: fromDateColumn(r.startDate),
        endDate: fromDateColumn(r.endDate),
        days: r.days,
        reason: r.reason,
        submittedAt: r.submittedAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        endReason: r.endReason,
        steps: r.steps.map((s) => ({
          position: s.position,
          kind: s.kind,
          approver: s.approverEmployee
            ? fullName(s.approverEmployee)
            : (s.approverRole?.name ?? null),
          status: s.status,
          actedBy: s.actedById ? (names.get(s.actedById) ?? null) : null,
          actedAt: s.actedAt?.toISOString() ?? null,
          note: s.note,
        })),
        can: {
          decide: r.status === 'PENDING' && !!current && this.canActOn(actor, r, current),
          withdraw: own && this.withdrawable(r),
          cancel:
            !own &&
            actor.permissions.has(PERMISSIONS.LEAVE_CANCEL_ANY) &&
            this.cancellable(r, today),
        },
      };
    });
  }

  private async activeType(id: string) {
    const type = await this.prisma.leaveType.findUnique({ where: { id } });
    if (!type || !type.isActive)
      throw new ValidationError([
        { path: 'leaveTypeId', message: 'Choose an available leave type' },
      ]);
    return type;
  }

  private async workingDates(employeeId: string, start: string, end: string): Promise<string[]> {
    const [schedule, holidays] = await Promise.all([
      this.schedules.forEmployee(employeeId),
      this.schedules.holidaysBetween(start, end),
    ]);
    return countLeaveDates(
      start,
      end,
      (d) => schedule.windowFor(d) !== null,
      (d) => holidays.has(d),
    );
  }

  /** Optional yearly allotment (Q-1): enforced only when HR has set one for the type and year. */
  private async assertBalance(
    tx: PrismaTx,
    employeeId: string,
    type: { id: string; name: string },
    dates: string[],
  ): Promise<void> {
    for (const [year, requested] of daysByYear(dates)) {
      const balance = await tx.leaveBalance.findUnique({
        where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: type.id, year } },
      });
      if (!balance) continue;
      const used = await tx.leaveRequestDay.count({
        where: {
          employeeId,
          date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) },
          request: { leaveTypeId: type.id, status: ACTIVE },
        },
      });
      const left = balance.allottedDays - used;
      if (requested > left)
        throw new ValidationError(
          [
            {
              path: 'leaveTypeId',
              message: `Only ${Math.max(0, left)} day(s) of ${type.name} left for ${year}; this request needs ${requested}`,
            },
          ],
          'Not enough leave balance',
        );
    }
  }

  private overlapError(o: { startDate: Date; endDate: Date }): ConflictError {
    return new ConflictError(
      `These dates overlap your request for ${fromDateColumn(o.startDate)} to ${fromDateColumn(o.endDate)}`,
    );
  }

  private async today(): Promise<string> {
    return workDateOf(this.clock.now(), await this.settings.get('company.timezone'));
  }
}
