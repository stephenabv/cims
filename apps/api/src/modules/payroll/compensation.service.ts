import { Injectable } from '@nestjs/common';
import type {
  CompensationListQuery,
  CompensationListRow,
  CompensationOverview,
  CompensationProfileInput,
  CompensationProfileView,
  EmployeePayItemInput,
  EmployeePayItemView,
  EndPayItemInput,
  PaginatedResult,
  PayrollPreview,
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
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { dateColumn, fromDateColumn, workDateOf } from '../attendance/domain/work-date';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { calculatePay } from './domain/payroll-calculator';
import { PayInputsService } from './pay-inputs.service';
import { payItemTypeView } from './payroll-config.service';

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;

const profileInclude = { undertimePolicy: { select: { id: true, name: true } } } as const;
type ProfileRow = Prisma.CompensationProfileGetPayload<{ include: typeof profileInclude }>;
type ItemRow = Prisma.EmployeePayItemGetPayload<{ include: { type: true } }>;

/**
 * Employee pay terms (spec §3.4 "Employee Salary Configuration"): versioned compensation
 * profiles, recurring allowances and deductions, and a live pay calculation for checking them.
 *
 * Pay data is sensitive: every read of one employee's pay is audited, and nobody can change
 * their own pay. Route permissions (payroll.compensation.view / .edit) are checked by the guard.
 */
@Injectable()
export class CompensationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inputs: PayInputsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  async list(q: CompensationListQuery): Promise<PaginatedResult<CompensationListRow>> {
    const today = dateColumn(await this.today());
    const and: Prisma.EmployeeWhereInput[] = [{ employmentStatus: { in: ['ACTIVE', 'ON_LEAVE'] } }];
    if (q.departmentId) and.push({ departmentId: q.departmentId });
    if (q.search)
      and.push({
        OR: [
          { firstName: { contains: q.search, mode: 'insensitive' } },
          { lastName: { contains: q.search, mode: 'insensitive' } },
          { accountNumber: { contains: q.search, mode: 'insensitive' } },
        ],
      });
    if (q.missing) and.push({ compensationProfiles: { none: { effectiveFrom: { lte: today } } } });
    const where: Prisma.EmployeeWhereInput = { AND: and };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          department: { select: { name: true } },
          compensationProfiles: {
            where: { effectiveFrom: { lte: today } },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
          _count: {
            select: {
              payItems: {
                where: {
                  effectiveFrom: { lte: today },
                  OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
                },
              },
            },
          },
        },
      }),
      this.prisma.employee.count({ where }),
    ]);
    return {
      data: rows.map((e) => {
        const p = e.compensationProfiles[0];
        return {
          employee: {
            id: e.id,
            accountNumber: e.accountNumber,
            fullName: fullName(e),
            department: e.department?.name ?? null,
          },
          current: p
            ? {
                hourlyRateCentavos: p.hourlyRateCentavos,
                paySchedule: p.paySchedule,
                effectiveFrom: fromDateColumn(p.effectiveFrom),
              }
            : null,
          activeItems: e._count.payItems,
        };
      }),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  }

  async overview(
    actor: AuthContext,
    employeeId: string,
    client: ClientInfo,
  ): Promise<CompensationOverview> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: {
        department: { select: { name: true } },
        position: { select: { title: true } },
        compensationProfiles: { include: profileInclude, orderBy: { effectiveFrom: 'desc' } },
        payItems: {
          include: { type: true },
          orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        },
      },
    });
    if (!employee) throw new NotFoundError('Employee');
    await this.audit.record({
      actorUserId: actor.userId,
      action: 'payroll.compensation.view',
      entityType: 'employee',
      entityId: employeeId,
      client,
    });
    const today = await this.today();
    const names = await this.names([
      ...employee.compensationProfiles.map((p) => p.createdById),
      ...employee.payItems.map((i) => i.createdById),
    ]);
    const current = employee.compensationProfiles.find(
      (p) => fromDateColumn(p.effectiveFrom) <= today,
    );
    return {
      employee: {
        id: employee.id,
        accountNumber: employee.accountNumber,
        fullName: fullName(employee),
        department: employee.department?.name ?? null,
        position: employee.position?.title ?? null,
        classification: employee.classification,
      },
      profiles: employee.compensationProfiles.map((p) =>
        this.profileView(p, today, p.id === current?.id, names),
      ),
      items: employee.payItems.map((i) => this.itemView(i, today, names)),
    };
  }

  /** What the employee would be paid for a period with today's data (no run is created). */
  async preview(
    actor: AuthContext,
    employeeId: string,
    from: string,
    to: string,
    client: ClientInfo,
  ): Promise<PayrollPreview> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, accountNumber: true, firstName: true, lastName: true },
    });
    if (!employee) throw new NotFoundError('Employee');
    const result = calculatePay(await this.inputs.forEmployee(employeeId, from, to));
    await this.audit.record({
      actorUserId: actor.userId,
      action: 'payroll.preview',
      entityType: 'employee',
      entityId: employeeId,
      metadata: { from, to },
      client,
    });
    return {
      employee: {
        id: employee.id,
        accountNumber: employee.accountNumber,
        fullName: fullName(employee),
      },
      ...result,
    };
  }

  // ── Profiles ───────────────────────────────────────────────────────────────

  async addProfile(
    actor: AuthContext,
    employeeId: string,
    input: CompensationProfileInput,
    client: ClientInfo,
  ): Promise<CompensationOverview> {
    this.assertNotSelf(actor, employeeId);
    await this.assertEmployee(employeeId);
    const policy = await this.prisma.undertimePolicy.findUnique({
      where: { id: input.undertimePolicyId },
    });
    if (!policy?.isActive)
      throw new ValidationError([
        { path: 'undertimePolicyId', message: 'Choose an active undertime policy' },
      ]);
    try {
      await this.prisma.$transaction(async (tx) => {
        const saved = await tx.compensationProfile.create({
          data: {
            employeeId,
            effectiveFrom: dateColumn(input.effectiveFrom),
            hourlyRateCentavos: input.hourlyRateCentavos,
            overtimeRateKind: input.overtimeRateKind,
            overtimeMultiplierPermille: input.overtimeMultiplierPermille,
            overtimeFixedRateCentavos: input.overtimeFixedRateCentavos,
            undertimePolicyId: input.undertimePolicyId,
            paySchedule: input.paySchedule,
            note: input.note || null,
            createdById: actor.userId,
          },
        });
        await this.audit.record(
          {
            actorUserId: actor.userId,
            action: 'payroll.compensation.add',
            entityType: 'compensation_profile',
            entityId: saved.id,
            after: { employeeId, ...input },
            client,
          },
          tx,
        );
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictError(
          'This employee already has pay terms starting that day. Pick another start date.',
        );
      throw e;
    }
    return this.overview(actor, employeeId, client);
  }

  /** Only a version that has not started yet can be removed; started ones stay for history. */
  async removeProfile(actor: AuthContext, id: string, client: ClientInfo): Promise<void> {
    const today = await this.today();
    await this.prisma.$transaction(async (tx) => {
      const profile = await tx.compensationProfile.findUnique({ where: { id } });
      if (!profile) throw new NotFoundError('Pay terms');
      this.assertNotSelf(actor, profile.employeeId);
      if (fromDateColumn(profile.effectiveFrom) <= today)
        throw new ConflictError(
          'These pay terms are already in force. Add new terms with a later start date instead.',
        );
      await tx.compensationProfile.delete({ where: { id } });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'payroll.compensation.remove',
          entityType: 'compensation_profile',
          entityId: id,
          before: { ...profile, effectiveFrom: fromDateColumn(profile.effectiveFrom) },
          client,
        },
        tx,
      );
    });
  }

  // ── Allowances and deductions ──────────────────────────────────────────────

  async addItem(
    actor: AuthContext,
    employeeId: string,
    input: EmployeePayItemInput,
    client: ClientInfo,
  ): Promise<CompensationOverview> {
    this.assertNotSelf(actor, employeeId);
    await this.assertEmployee(employeeId);
    const type = await this.prisma.payItemType.findUnique({ where: { id: input.typeId } });
    if (!type?.isActive)
      throw new ValidationError([{ path: 'typeId', message: 'Choose an active type' }]);
    if (type.direction === 'ALLOWANCE' && input.calculation !== 'FIXED')
      throw new ValidationError([{ path: 'calculation', message: 'Allowances are fixed amounts' }]);
    await this.prisma.$transaction(async (tx) => {
      const saved = await tx.employeePayItem.create({
        data: {
          employeeId,
          typeId: input.typeId,
          calculation: input.calculation,
          amountCentavos: input.amountCentavos,
          rateBasisPoints: input.rateBasisPoints,
          effectiveFrom: dateColumn(input.effectiveFrom),
          effectiveTo: input.effectiveTo ? dateColumn(input.effectiveTo) : null,
          note: input.note || null,
          createdById: actor.userId,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'payroll.item.add',
          entityType: 'employee_pay_item',
          entityId: saved.id,
          after: { employeeId, ...input },
          client,
        },
        tx,
      );
    });
    return this.overview(actor, employeeId, client);
  }

  /** Stops a running allowance or deduction after a date (inclusive). */
  async endItem(
    actor: AuthContext,
    id: string,
    input: EndPayItemInput,
    client: ClientInfo,
  ): Promise<CompensationOverview> {
    const employeeId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM employee_pay_item WHERE id = ${id}::uuid FOR UPDATE`;
      const item = await tx.employeePayItem.findUnique({ where: { id } });
      if (!item) throw new NotFoundError('Allowance or deduction');
      this.assertNotSelf(actor, item.employeeId);
      if (item.version !== input.version)
        throw new ConflictError('This item changed since you opened it. Reload and try again.');
      const from = fromDateColumn(item.effectiveFrom);
      if (input.effectiveTo < from)
        throw new ValidationError([
          { path: 'effectiveTo', message: `It cannot end before it starts (${from})` },
        ]);
      await tx.employeePayItem.update({
        where: { id },
        data: { effectiveTo: dateColumn(input.effectiveTo), version: { increment: 1 } },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'payroll.item.end',
          entityType: 'employee_pay_item',
          entityId: id,
          before: { effectiveTo: item.effectiveTo ? fromDateColumn(item.effectiveTo) : null },
          after: { effectiveTo: input.effectiveTo },
          client,
        },
        tx,
      );
      return item.employeeId;
    });
    return this.overview(actor, employeeId, client);
  }

  async removeItem(actor: AuthContext, id: string, client: ClientInfo): Promise<void> {
    const today = await this.today();
    await this.prisma.$transaction(async (tx) => {
      const item = await tx.employeePayItem.findUnique({ where: { id } });
      if (!item) throw new NotFoundError('Allowance or deduction');
      this.assertNotSelf(actor, item.employeeId);
      if (fromDateColumn(item.effectiveFrom) <= today)
        throw new ConflictError('This item has already started. End it instead of removing it.');
      await tx.employeePayItem.delete({ where: { id } });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'payroll.item.remove',
          entityType: 'employee_pay_item',
          entityId: id,
          client,
        },
        tx,
      );
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private assertNotSelf(actor: AuthContext, employeeId: string): void {
    if (actor.employeeId === employeeId) throw new ForbiddenError('You cannot change your own pay');
  }

  private async assertEmployee(id: string): Promise<void> {
    if (!(await this.prisma.employee.count({ where: { id } }))) throw new NotFoundError('Employee');
  }

  private async today(): Promise<string> {
    return workDateOf(this.clock.now(), await this.settings.get('company.timezone'));
  }

  private async names(userIds: string[]): Promise<Map<string, string>> {
    const users = await this.prisma.userAccount.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, employee: { select: { firstName: true, lastName: true } } },
    });
    return new Map(users.map((u) => [u.id, fullName(u.employee)]));
  }

  private profileView(
    p: ProfileRow,
    today: string,
    isCurrent: boolean,
    names: Map<string, string>,
  ): CompensationProfileView {
    const from = fromDateColumn(p.effectiveFrom);
    return {
      id: p.id,
      effectiveFrom: from,
      hourlyRateCentavos: p.hourlyRateCentavos,
      overtimeRateKind: p.overtimeRateKind,
      overtimeMultiplierPermille: p.overtimeMultiplierPermille,
      overtimeFixedRateCentavos: p.overtimeFixedRateCentavos,
      undertimePolicy: p.undertimePolicy,
      paySchedule: p.paySchedule,
      note: p.note,
      createdBy: names.get(p.createdById) ?? null,
      createdAt: p.createdAt.toISOString(),
      isCurrent,
      canRemove: from > today,
    };
  }

  private itemView(i: ItemRow, today: string, names: Map<string, string>): EmployeePayItemView {
    const from = fromDateColumn(i.effectiveFrom);
    const to = i.effectiveTo ? fromDateColumn(i.effectiveTo) : null;
    return {
      id: i.id,
      version: i.version,
      type: payItemTypeView(i.type),
      calculation: i.calculation,
      amountCentavos: i.amountCentavos,
      rateBasisPoints: i.rateBasisPoints,
      effectiveFrom: from,
      effectiveTo: to,
      note: i.note,
      createdBy: names.get(i.createdById) ?? null,
      isActive: from <= today && (to === null || to >= today),
      canRemove: from > today,
    };
  }
}
