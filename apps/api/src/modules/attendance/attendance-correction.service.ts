import { Injectable } from '@nestjs/common';
import {
  type CancelCorrectionInput,
  type CorrectionDecisionInput,
  type CorrectionRequestView,
  type CorrectionType,
  type MyCorrectionsQuery,
  type PaginatedResult,
  PERMISSIONS,
  type PunchType,
  SYSTEM_ROLES,
  type SubmitCorrectionInput,
} from '@cims/shared';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { resolveApprovalSteps } from '../leave/domain/approval-chain';
import { type NewNotification, NotificationService } from '../notifications/notification.service';
import { SettingsService } from '../settings/settings.service';
import { AttendanceDayService } from './attendance-day.service';
import { addDays, dateColumn, fromDateColumn, instantAt, workDateOf } from './domain/work-date';

/** Corrections may be requested for records up to this many days old. */
export const MAX_CORRECTION_AGE_DAYS = 60;

const include = {
  employee: { select: { id: true, accountNumber: true, firstName: true, lastName: true } },
  steps: {
    orderBy: { position: 'asc' },
    include: {
      approverEmployee: { select: { firstName: true, lastName: true } },
      approverRole: { select: { key: true, name: true } },
    },
  },
} satisfies Prisma.AttendanceCorrectionRequestInclude;

type RequestRow = Prisma.AttendanceCorrectionRequestGetPayload<{ include: typeof include }>;
type StepRow = RequestRow['steps'][number];

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;

/** Which punch a request type concerns, when it is fixed by the type. */
const PUNCH_OF: Partial<Record<CorrectionType, PunchType>> = {
  CHANGE_TIME_IN: 'TIME_IN',
  CHANGE_TIME_OUT: 'TIME_OUT',
  MISSING_TIME_IN: 'TIME_IN',
  MISSING_TIME_OUT: 'TIME_OUT',
};

export const CORRECTION_LABEL: Record<CorrectionType, string> = {
  CHANGE_TIME_IN: 'Change of time in',
  CHANGE_TIME_OUT: 'Change of time out',
  MISSING_TIME_IN: 'Missing time in',
  MISSING_TIME_OUT: 'Missing time out',
  INCORRECT_TIMESTAMP: 'Incorrect timestamp',
  OTHER: 'Other correction',
};

/**
 * Employee attendance correction requests (attendance spec §2).
 *
 * Employees never touch punches. A request records the original value, the requested value and a
 * mandatory reason, then goes through the configured approval chain (same rules as leave: skipped
 * unresolvable steps, never self-approval, HR fallback). Role steps are actionable by holders of
 * the role who also have `attendance.adjust`.
 *
 * On final approval the correction is applied exactly like an HR adjustment, in the same
 * transaction: the wrong punch is voided (kept, with the reason), a corrected ADJUSTMENT punch is
 * added, and the day is recomputed. The request row keeps original / requested / applied values,
 * and the audit log gets the before/after. Requests are never deleted (database trigger).
 *
 * Concurrency: state changes lock the request row and check the client's `version`; applying
 * locks the employee row shared with kiosk punches, sync and HR adjustments.
 */
@Injectable()
export class AttendanceCorrectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly days: AttendanceDayService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  // ── Filing ─────────────────────────────────────────────────────────────────

  async submit(
    actor: AuthContext,
    input: SubmitCorrectionInput,
    client: ClientInfo,
  ): Promise<CorrectionRequestView> {
    const now = this.clock.now();
    const timezone = await this.settings.get('company.timezone');
    const today = workDateOf(now, timezone);
    if (input.workDate > today)
      throw this.invalid('workDate', 'You cannot request a correction for a future date');
    if (input.workDate < addDays(today, -MAX_CORRECTION_AGE_DAYS))
      throw this.invalid(
        'workDate',
        `Corrections can be requested up to ${MAX_CORRECTION_AGE_DAYS} days back. Ask HR for older records.`,
      );
    const { dateHired } = await this.prisma.employee.findUniqueOrThrow({
      where: { id: actor.employeeId },
      select: { dateHired: true },
    });
    if (input.workDate < fromDateColumn(dateHired))
      throw this.invalid('workDate', 'This date is before your hire date');

    const requestedAt =
      input.requestedDate && input.requestedTime && input.type !== 'OTHER'
        ? this.wallClock(input.requestedDate, input.requestedTime, timezone)
        : null;
    if (requestedAt) {
      if (requestedAt > now)
        throw this.invalid('requestedTime', 'The time cannot be in the future');
      // A shift's punches fall between the evening before and the morning after its date.
      const lo = instantAt(input.workDate, -12 * 60, timezone);
      const hi = instantAt(input.workDate, 36 * 60, timezone);
      if (requestedAt < lo || requestedAt > hi)
        throw this.invalid(
          'requestedDate',
          'The time must be within this attendance record’s shift',
        );
    }

    const hr = await this.prisma.role.findUniqueOrThrow({ where: { key: SYSTEM_ROLES.HR } });
    const chain = await this.chain();

    try {
      const { id, notices } = await this.prisma.$transaction(async (tx) => {
        await this.lockEmployee(tx, actor.employeeId);
        const punches = await this.dayPunches(tx, actor.employeeId, input.workDate);
        const { punchType, target } = this.checkAgainstRecord(input, punches, requestedAt);

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
        let firstApprover: string | null = null;
        const request = await tx.attendanceCorrectionRequest.create({
          data: {
            employeeId: actor.employeeId,
            workDate: dateColumn(input.workDate),
            type: input.type,
            punchType,
            targetEventId: target?.id ?? null,
            originalAt: target?.occurredAt ?? null,
            requestedAt,
            reason: input.reason,
            submittedAt: now,
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
                if (first) firstApprover = s.approverEmployeeId;
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
          },
        });
        await this.audit.record(
          {
            actorUserId: actor.userId,
            action: 'attendance.correction.submit',
            entityType: 'attendance_correction_request',
            entityId: request.id,
            after: {
              employeeId: actor.employeeId,
              workDate: input.workDate,
              type: input.type,
              targetEventId: target?.id ?? null,
              originalAt: target?.occurredAt.toISOString() ?? null,
              requestedAt: requestedAt?.toISOString() ?? null,
              reason: input.reason,
            },
            client,
          },
          tx,
        );
        const notices = await this.notifyApprover(tx, firstApprover, request.id, actor);
        return { id: request.id, notices };
      });
      await this.notifications.deliver(notices);
      return this.get(actor, id);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictError(
          'You already have a pending request of this kind for this date. Cancel it or wait for the decision.',
        );
      throw err;
    }
  }

  // ── Decisions ──────────────────────────────────────────────────────────────

  async decide(
    actor: AuthContext,
    id: string,
    input: CorrectionDecisionInput,
    client: ClientInfo,
  ): Promise<CorrectionRequestView> {
    const now = this.clock.now();
    const notices = await this.prisma.$transaction(async (tx) => {
      const request = await this.lockForChange(tx, actor, id, input.version);
      if (request.employeeId === actor.employeeId)
        throw new ForbiddenError('You cannot approve or reject your own correction request');
      if (request.status !== 'PENDING')
        throw new ConflictError('This request has already been decided');
      const current = request.steps.find((s) => s.status === 'PENDING');
      if (!current || !this.canActOn(actor, request, current))
        throw new ForbiddenError('You are not the approver for the current step of this request');

      const approve = input.decision === 'APPROVE';
      const note = input.note?.trim() || null;
      await tx.attendanceCorrectionStep.update({
        where: { id: current.id },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          actedById: actor.userId,
          actedAt: now,
          note,
        },
      });
      const next = approve ? request.steps.find((s) => s.status === 'WAITING') : undefined;
      if (next) {
        await tx.attendanceCorrectionStep.update({
          where: { id: next.id },
          data: { status: 'PENDING' },
        });
      } else if (!approve) {
        await tx.attendanceCorrectionStep.updateMany({
          where: { requestId: id, status: 'WAITING' },
          data: { status: 'CANCELLED' },
        });
      }
      const status = !approve ? 'REJECTED' : next ? 'PENDING' : 'APPROVED';
      const applied = status === 'APPROVED' ? await this.apply(tx, actor, request, now) : null;

      await tx.attendanceCorrectionRequest.update({
        where: { id },
        data: {
          status,
          version: { increment: 1 },
          ...(status === 'PENDING'
            ? {}
            : { decidedAt: now, decidedById: actor.userId, decisionNote: note }),
          ...(applied ?? {}),
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action:
            status === 'REJECTED'
              ? 'attendance.correction.reject'
              : status === 'APPROVED'
                ? 'attendance.correction.approve'
                : 'attendance.correction.approve_step',
          entityType: 'attendance_correction_request',
          entityId: id,
          before: {
            status: 'PENDING',
            step: current.position,
            originalAt: request.originalAt?.toISOString() ?? null,
          },
          after: {
            status,
            step: current.position,
            note,
            requestedAt: request.requestedAt?.toISOString() ?? null,
            appliedAt: applied?.appliedAt?.toISOString() ?? null,
            appliedEventId: applied?.appliedEventId ?? null,
            voidedEventId: applied?.voidedEventId ?? null,
          },
          client,
        },
        tx,
      );

      if (status === 'PENDING') {
        return this.notifyApprover(tx, next?.approverEmployeeId ?? null, id, null, request);
      }
      return this.notifyEmployee(tx, request, status, note);
    });
    await this.notifications.deliver(notices);
    return this.get(actor, id);
  }

  /** The employee withdraws a request no approver has acted on yet. */
  async cancel(
    actor: AuthContext,
    id: string,
    input: CancelCorrectionInput,
    client: ClientInfo,
  ): Promise<CorrectionRequestView> {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const request = await this.lockForChange(tx, actor, id, input.version);
      if (request.employeeId !== actor.employeeId) throw new NotFoundError('Correction request');
      if (!this.cancellable(request))
        throw new ConflictError(
          request.status === 'PENDING'
            ? 'An approver has already acted on this request, so it can no longer be cancelled.'
            : 'Only a pending request can be cancelled',
        );
      await tx.attendanceCorrectionStep.updateMany({
        where: { requestId: id, status: { in: ['PENDING', 'WAITING'] } },
        data: { status: 'CANCELLED' },
      });
      await tx.attendanceCorrectionRequest.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          version: { increment: 1 },
          decidedAt: now,
          decidedById: actor.userId,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'attendance.correction.cancel',
          entityType: 'attendance_correction_request',
          entityId: id,
          before: { status: 'PENDING' },
          after: { status: 'CANCELLED' },
          client,
        },
        tx,
      );
    });
    return this.get(actor, id);
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async get(actor: AuthContext, id: string): Promise<CorrectionRequestView> {
    const row = await this.prisma.attendanceCorrectionRequest.findUnique({
      where: { id },
      include,
    });
    if (!row || !(await this.canView(actor, row))) throw new NotFoundError('Correction request');
    return (await this.views(actor, [row]))[0]!;
  }

  mine(actor: AuthContext, q: MyCorrectionsQuery): Promise<PaginatedResult<CorrectionRequestView>> {
    return this.page(actor, { employeeId: actor.employeeId, status: q.status }, q);
  }

  /** Requests whose current step the actor can decide (never their own). */
  approvals(
    actor: AuthContext,
    q: { page: number; pageSize: number },
  ): Promise<PaginatedResult<CorrectionRequestView>> {
    const or: Prisma.AttendanceCorrectionStepWhereInput[] = [
      { approverEmployeeId: actor.employeeId },
    ];
    if (actor.permissions.has(PERMISSIONS.ATTENDANCE_ADJUST))
      or.push({ approverRole: { key: actor.roleKey } });
    return this.page(
      actor,
      {
        status: 'PENDING',
        employeeId: { not: actor.employeeId },
        steps: { some: { status: 'PENDING', OR: or } },
      },
      q,
      'asc',
    );
  }

  async approvalChainSetting(): Promise<{ approvalChainId: string | null }> {
    const v = await this.settings.get('attendance.correctionApprovalChainId');
    return { approvalChainId: v === 'default' ? null : v };
  }

  async setApprovalChain(actor: AuthContext, chainId: string | null): Promise<void> {
    if (chainId && !(await this.prisma.approvalChain.findUnique({ where: { id: chainId } })))
      throw this.invalid('approvalChainId', 'Choose an existing approval chain');
    await this.settings.set(
      'attendance.correctionApprovalChainId',
      chainId ?? 'default',
      actor.userId,
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Validates a request against the record as it stands, under the employee lock. Returns the
   * punch type concerned and the targeted punch.
   */
  private checkAgainstRecord(
    input: SubmitCorrectionInput,
    punches: { id: string; type: PunchType; occurredAt: Date }[],
    requestedAt: Date | null,
  ): {
    punchType: PunchType | null;
    target: { id: string; occurredAt: Date; type: PunchType } | null;
  } {
    let target: (typeof punches)[number] | null = null;
    if (input.targetEventId) {
      target = punches.find((p) => p.id === input.targetEventId) ?? null;
      // Someone else's punch, a voided one, or one on another date: same answer, no disclosure.
      if (!target)
        throw this.invalid('targetEventId', 'Choose a punch from this attendance record');
    }
    const fixed = PUNCH_OF[input.type];
    if (fixed && target && target.type !== fixed)
      throw this.invalid(
        'targetEventId',
        `Choose a ${fixed === 'TIME_IN' ? 'time in' : 'time out'} punch for this request`,
      );
    const punchType = fixed ?? target?.type ?? null;

    if (input.type === 'MISSING_TIME_IN' && punches.some((p) => p.type === 'TIME_IN'))
      throw this.invalid(
        'type',
        'This record already has a time in. Request a change of time in instead.',
      );
    if (input.type === 'MISSING_TIME_OUT' && punches.some((p) => p.type === 'TIME_OUT'))
      throw this.invalid(
        'type',
        'This record already has a time out. Request a change of time out instead.',
      );

    if (requestedAt && punchType) {
      if (target && target.occurredAt.getTime() === requestedAt.getTime())
        throw this.invalid('requestedTime', 'The requested time is the same as the recorded time');
      // Keep the corrected record in order: a time in before the time out, and vice versa.
      const others = punches.filter((p) => p.id !== target?.id);
      const firstIn = others.find((p) => p.type === 'TIME_IN');
      const lastOut = [...others].reverse().find((p) => p.type === 'TIME_OUT');
      if (punchType === 'TIME_IN' && lastOut && requestedAt >= lastOut.occurredAt)
        throw this.invalid('requestedTime', 'A time in must be before the time out');
      if (punchType === 'TIME_OUT' && firstIn && requestedAt <= firstIn.occurredAt)
        throw this.invalid('requestedTime', 'A time out must be after the time in');
    }
    return { punchType, target: target ?? null };
  }

  /** Writes an approved correction to the official record, as an HR adjustment would. */
  private async apply(
    tx: PrismaTx,
    actor: AuthContext,
    r: RequestRow,
    now: Date,
  ): Promise<{ appliedEventId: string; voidedEventId: string | null; appliedAt: Date } | null> {
    if (r.type === 'OTHER' || !r.requestedAt || !r.punchType) return null;
    await this.lockEmployee(tx, r.employeeId);
    const workDate = fromDateColumn(r.workDate);
    const note = `Correction request ${r.id.slice(0, 8)}: ${r.reason}`.slice(0, 500);

    let voidedEventId: string | null = null;
    if (r.targetEventId) {
      const voided = await tx.attendanceEvent.updateMany({
        where: { id: r.targetEventId, status: 'ACCEPTED' },
        data: { status: 'VOIDED', voidedById: actor.userId, voidedAt: now, voidReason: note },
      });
      if (voided.count === 0)
        throw new ConflictError(
          'The punch in this request was changed after it was filed. Reject the request and ask the employee to file it again.',
        );
      voidedEventId = r.targetEventId;
    }
    const event = await tx.attendanceEvent.create({
      data: {
        employeeId: r.employeeId,
        type: r.punchType,
        occurredAt: r.requestedAt,
        recordedAt: now,
        workDate: r.workDate,
        source: 'ADJUSTMENT',
        status: 'ACCEPTED',
        createdById: actor.userId,
        note,
      },
    });
    await this.days.recompute(tx, r.employeeId, workDate);
    return { appliedEventId: event.id, voidedEventId, appliedAt: r.requestedAt };
  }

  private async notifyApprover(
    tx: PrismaTx,
    approverEmployeeId: string | null,
    requestId: string,
    applicant: AuthContext | null,
    row?: RequestRow,
  ): Promise<NewNotification[]> {
    if (!approverEmployeeId) return [];
    const account = await tx.userAccount.findUnique({
      where: { employeeId: approverEmployeeId },
      select: { id: true },
    });
    if (!account) return [];
    const applicantId = row?.employeeId ?? applicant?.employeeId;
    const person = applicantId
      ? await tx.employee.findUnique({
          where: { id: applicantId },
          select: { firstName: true, lastName: true },
        })
      : null;
    const who = person ? fullName(person) : 'An employee';
    return this.notifications.create(tx, [
      {
        userId: account.id,
        kind: 'attendance.correction.awaiting',
        title: 'Attendance correction awaiting your review',
        body: `${who} asked to correct an attendance record. Review it in CIMS (request ${requestId.slice(0, 8)}).`,
        link: '/app/attendance/approvals',
      },
    ]);
  }

  private async notifyEmployee(
    tx: PrismaTx,
    r: RequestRow,
    status: 'APPROVED' | 'REJECTED',
    note: string | null,
  ): Promise<NewNotification[]> {
    const account = await tx.userAccount.findUnique({
      where: { employeeId: r.employeeId },
      select: { id: true },
    });
    if (!account) return [];
    const what = `${CORRECTION_LABEL[r.type]} for ${DateTime.fromJSDate(r.workDate, { zone: 'UTC' }).toFormat('ccc, LLL d')}`;
    return this.notifications.create(tx, [
      {
        userId: account.id,
        kind: `attendance.correction.${status.toLowerCase()}`,
        title:
          status === 'APPROVED'
            ? 'Attendance correction approved'
            : 'Attendance correction rejected',
        body:
          status === 'APPROVED'
            ? `Your request (${what}) was approved${r.type === 'OTHER' ? '. HR will update the record.' : ' and your attendance record was updated.'}${note ? ` Remarks: ${note}` : ''}`
            : `Your request (${what}) was rejected. Reason: ${note ?? 'not given'}`,
        link: '/app/attendance/corrections',
      },
    ]);
  }

  private async chain() {
    const id = await this.settings.get('attendance.correctionApprovalChainId');
    const include = { steps: { orderBy: { position: 'asc' as const } } };
    const configured =
      id === 'default'
        ? null
        : await this.prisma.approvalChain.findUnique({ where: { id }, include });
    return (
      configured ?? this.prisma.approvalChain.findFirst({ where: { isDefault: true }, include })
    );
  }

  private async page(
    actor: AuthContext,
    where: Prisma.AttendanceCorrectionRequestWhereInput,
    q: { page: number; pageSize: number },
    order: 'asc' | 'desc' = 'desc',
  ): Promise<PaginatedResult<CorrectionRequestView>> {
    const [rows, total] = await Promise.all([
      this.prisma.attendanceCorrectionRequest.findMany({
        where,
        include,
        orderBy: { submittedAt: order },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.attendanceCorrectionRequest.count({ where }),
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
    await tx.$queryRaw`SELECT id FROM attendance_correction_request WHERE id = ${id}::uuid FOR UPDATE`;
    const request = await tx.attendanceCorrectionRequest.findUnique({ where: { id }, include });
    if (!request || !(await this.canView(actor, request, tx)))
      throw new NotFoundError('Correction request');
    if (request.version !== version)
      throw new ConflictError('This request was changed by someone else. Reload it and try again.');
    return request;
  }

  private canActOn(actor: AuthContext, r: RequestRow, step: StepRow): boolean {
    if (r.employeeId === actor.employeeId) return false;
    if (step.approverEmployeeId) return step.approverEmployeeId === actor.employeeId;
    return (
      step.approverRole?.key === actor.roleKey &&
      actor.permissions.has(PERMISSIONS.ATTENDANCE_ADJUST)
    );
  }

  private cancellable(r: RequestRow): boolean {
    return r.status === 'PENDING' && !r.steps.some((s) => s.status === 'APPROVED');
  }

  /** Owner, anyone on its chain, or a viewer with attendance visibility over the employee. */
  private async canView(
    actor: AuthContext,
    r: RequestRow,
    tx: PrismaTx = this.prisma,
  ): Promise<boolean> {
    if (r.employeeId === actor.employeeId) return true;
    if (r.steps.some((s) => s.approverEmployeeId === actor.employeeId)) return true;
    if (
      actor.permissions.has(PERMISSIONS.ATTENDANCE_ADJUST) &&
      r.steps.some((s) => s.approverRole?.key === actor.roleKey)
    )
      return true;
    if (actor.permissions.has(PERMISSIONS.ATTENDANCE_VIEW_ALL)) return true;
    if (actor.permissions.has(PERMISSIONS.ATTENDANCE_VIEW_DEPARTMENT)) {
      const e = await tx.employee.findUnique({
        where: { id: r.employeeId },
        select: { department: { select: { headId: true } } },
      });
      return e?.department?.headId === actor.employeeId;
    }
    return false;
  }

  private async views(actor: AuthContext, rows: RequestRow[]): Promise<CorrectionRequestView[]> {
    if (rows.length === 0) return [];
    const userIds = [
      ...new Set(
        rows
          .flatMap((r) => [...r.steps.map((s) => s.actedById), r.decidedById])
          .filter((x): x is string => !!x),
      ),
    ];
    const [users, punches] = await Promise.all([
      this.prisma.userAccount.findMany({
        where: { id: { in: userIds } },
        select: { id: true, employee: { select: { firstName: true, lastName: true } } },
      }),
      this.prisma.attendanceEvent.findMany({
        where: {
          OR: rows.map((r) => ({ employeeId: r.employeeId, workDate: r.workDate })),
          status: { in: ['ACCEPTED', 'VOIDED'] },
        },
        orderBy: { occurredAt: 'asc' },
        select: {
          id: true,
          employeeId: true,
          workDate: true,
          type: true,
          occurredAt: true,
          status: true,
          source: true,
        },
      }),
    ]);
    const names = new Map(users.map((u) => [u.id, fullName(u.employee)]));
    const timezone = await this.settings.get('company.timezone');
    return rows.map((r) => {
      const current = r.steps.find((s) => s.status === 'PENDING');
      const own = r.employeeId === actor.employeeId;
      const date = fromDateColumn(r.workDate);
      return {
        id: r.id,
        version: r.version,
        status: r.status,
        type: r.type,
        punchType: r.punchType,
        employee: {
          id: r.employee.id,
          accountNumber: r.employee.accountNumber,
          fullName: fullName(r.employee),
        },
        workDate: date,
        timezone,
        originalAt: r.originalAt?.toISOString() ?? null,
        requestedAt: r.requestedAt?.toISOString() ?? null,
        appliedAt: r.appliedAt?.toISOString() ?? null,
        reason: r.reason,
        submittedAt: r.submittedAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decidedBy: r.decidedById ? (names.get(r.decidedById) ?? null) : null,
        decisionNote: r.decisionNote,
        currentPunches: punches
          .filter((p) => p.employeeId === r.employeeId && fromDateColumn(p.workDate) === date)
          .map((p) => ({
            id: p.id,
            type: p.type,
            occurredAt: p.occurredAt.toISOString(),
            status: p.status,
            source: p.source,
          })),
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
          cancel: own && this.cancellable(r),
        },
      };
    });
  }

  private async dayPunches(tx: PrismaTx, employeeId: string, workDate: string) {
    return tx.attendanceEvent.findMany({
      where: { employeeId, workDate: dateColumn(workDate), status: 'ACCEPTED' },
      orderBy: { occurredAt: 'asc' },
      select: { id: true, type: true, occurredAt: true },
    });
  }

  private wallClock(date: string, time: string, timezone: string): Date {
    const [h, m] = time.split(':').map(Number) as [number, number];
    return instantAt(date, h * 60 + m, timezone);
  }

  private invalid(path: string, message: string): ValidationError {
    return new ValidationError([{ path, message }], message);
  }

  private async lockEmployee(tx: PrismaTx, employeeId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM employee WHERE id = ${employeeId}::uuid FOR UPDATE`;
  }
}
