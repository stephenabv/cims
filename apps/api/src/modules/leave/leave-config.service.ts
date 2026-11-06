import { Injectable } from '@nestjs/common';
import type {
  ApprovalChainInput,
  ApprovalChainView,
  LeaveBalanceInput,
  LeaveBalanceView,
  LeaveTypeInput,
  LeaveTypeView,
} from '@cims/shared';
import { Prisma } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const chainInclude = {
  steps: {
    orderBy: { position: 'asc' },
    include: {
      role: { select: { name: true } },
      employee: { select: { firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.ApprovalChainInclude;

type ChainRow = Prisma.ApprovalChainGetPayload<{ include: typeof chainInclude }>;

const typeView = (t: {
  id: string;
  code: string;
  name: string;
  isPaid: boolean;
  isActive: boolean;
  approvalChainId: string | null;
}): LeaveTypeView => ({
  id: t.id,
  code: t.code,
  name: t.name,
  isPaid: t.isPaid,
  isActive: t.isActive,
  approvalChainId: t.approvalChainId,
});

/** Leave types, approval chains and yearly allotments (spec §3.3, open question Q-1). */
@Injectable()
export class LeaveConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Types ──────────────────────────────────────────────────────────────────

  async types(includeInactive: boolean): Promise<LeaveTypeView[]> {
    const rows = await this.prisma.leaveType.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
    });
    return rows.map(typeView);
  }

  async saveType(
    actor: AuthContext,
    id: string | null,
    input: LeaveTypeInput,
    client: ClientInfo,
  ): Promise<LeaveTypeView> {
    if (input.approvalChainId) await this.assertChainExists(input.approvalChainId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = id ? await tx.leaveType.findUnique({ where: { id } }) : null;
        if (id && !before) throw new NotFoundError('Leave type');
        const saved = id
          ? await tx.leaveType.update({ where: { id }, data: input })
          : await tx.leaveType.create({ data: input });
        await this.audit.record(
          {
            actorUserId: actor.userId,
            action: id ? 'leave.type.update' : 'leave.type.create',
            entityType: 'leave_type',
            entityId: saved.id,
            before: before ? typeView(before) : undefined,
            after: typeView(saved),
            client,
          },
          tx,
        );
        return typeView(saved);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictError('A leave type with this code or name already exists');
      throw err;
    }
  }

  // ── Approval chains ────────────────────────────────────────────────────────

  roles(): Promise<{ id: string; name: string }[]> {
    return this.prisma.role.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async chains(): Promise<ApprovalChainView[]> {
    const rows = await this.prisma.approvalChain.findMany({
      include: chainInclude,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return rows.map((c) => this.chainView(c));
  }

  /**
   * Saves a chain's steps. Requests already submitted keep the approvers resolved when they were
   * filed; only new requests use the new steps.
   */
  async saveChain(
    actor: AuthContext,
    id: string | null,
    input: ApprovalChainInput,
    client: ClientInfo,
  ): Promise<ApprovalChainView> {
    await this.validateStepTargets(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = id
          ? await tx.approvalChain.findUnique({ where: { id }, include: chainInclude })
          : null;
        if (id && !before) throw new NotFoundError('Approval chain');
        const steps = input.steps.map((s, i) => ({ position: i + 1, ...s }));
        // Replace steps explicitly: (chain, position) is unique, so old rows must go first.
        if (id) await tx.approvalChainStep.deleteMany({ where: { chainId: id } });
        const saved = id
          ? await tx.approvalChain.update({
              where: { id },
              data: { name: input.name, steps: { create: steps } },
              include: chainInclude,
            })
          : await tx.approvalChain.create({
              data: { name: input.name, steps: { create: steps } },
              include: chainInclude,
            });
        await this.audit.record(
          {
            actorUserId: actor.userId,
            action: id ? 'leave.chain.update' : 'leave.chain.create',
            entityType: 'approval_chain',
            entityId: saved.id,
            before: before ? this.chainView(before) : undefined,
            after: this.chainView(saved),
            client,
          },
          tx,
        );
        return this.chainView(saved);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictError('An approval chain with this name already exists');
      throw err;
    }
  }

  // ── Balances ───────────────────────────────────────────────────────────────

  /** Allotment, approved, pending and remaining days for every active type in a year. */
  async balances(employeeId: string, year: number): Promise<LeaveBalanceView[]> {
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year, 11, 31));
    const [types, allotments, used] = await Promise.all([
      this.prisma.leaveType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      this.prisma.leaveBalance.findMany({ where: { employeeId, year } }),
      this.prisma.$queryRaw<{ leave_type_id: string; status: string; days: bigint }[]>`
        SELECT r.leave_type_id, r.status::text AS status, count(*) AS days
        FROM leave_request_day d JOIN leave_request r ON r.id = d.request_id
        WHERE d.employee_id = ${employeeId}::uuid AND d.date BETWEEN ${from} AND ${to}
          AND r.status IN ('PENDING', 'APPROVED')
        GROUP BY r.leave_type_id, r.status`,
    ]);
    const allotted = new Map(allotments.map((b) => [b.leaveTypeId, b.allottedDays]));
    const usage = (typeId: string, status: string) =>
      Number(used.find((u) => u.leave_type_id === typeId && u.status === status)?.days ?? 0);
    return types.map((t) => {
      const approvedDays = usage(t.id, 'APPROVED');
      const pendingDays = usage(t.id, 'PENDING');
      const allottedDays = allotted.get(t.id) ?? null;
      return {
        leaveType: { id: t.id, code: t.code, name: t.name, isPaid: t.isPaid },
        year,
        allottedDays,
        approvedDays,
        pendingDays,
        remainingDays: allottedDays === null ? null : allottedDays - approvedDays - pendingDays,
      };
    });
  }

  async setBalance(
    actor: AuthContext,
    input: LeaveBalanceInput,
    client: ClientInfo,
  ): Promise<void> {
    const [employee, type] = await Promise.all([
      this.prisma.employee.findUnique({ where: { id: input.employeeId }, select: { id: true } }),
      this.prisma.leaveType.findUnique({ where: { id: input.leaveTypeId }, select: { id: true } }),
    ]);
    if (!employee) throw new NotFoundError('Employee');
    if (!type) throw new NotFoundError('Leave type');
    const key = {
      employeeId_leaveTypeId_year: {
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        year: input.year,
      },
    };
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.leaveBalance.findUnique({ where: key });
      if (input.allottedDays === null) {
        if (before) await tx.leaveBalance.delete({ where: key });
      } else {
        await tx.leaveBalance.upsert({
          where: key,
          create: {
            employeeId: input.employeeId,
            leaveTypeId: input.leaveTypeId,
            year: input.year,
            allottedDays: input.allottedDays,
            updatedById: actor.userId,
          },
          update: { allottedDays: input.allottedDays, updatedById: actor.userId },
        });
      }
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'leave.balance.set',
          entityType: 'employee',
          entityId: input.employeeId,
          before: {
            leaveTypeId: input.leaveTypeId,
            year: input.year,
            allottedDays: before?.allottedDays ?? null,
          },
          after: {
            leaveTypeId: input.leaveTypeId,
            year: input.year,
            allottedDays: input.allottedDays,
          },
          client,
        },
        tx,
      );
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async assertChainExists(id: string): Promise<void> {
    if (!(await this.prisma.approvalChain.findUnique({ where: { id }, select: { id: true } })))
      throw new ValidationError([{ path: 'approvalChainId', message: 'Unknown approval chain' }]);
  }

  private async validateStepTargets(input: ApprovalChainInput): Promise<void> {
    const roleIds = input.steps.flatMap((s) => (s.roleId ? [s.roleId] : []));
    const employeeIds = input.steps.flatMap((s) => (s.employeeId ? [s.employeeId] : []));
    const [roles, employees] = await Promise.all([
      this.prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true } }),
      this.prisma.employee.findMany({
        where: { id: { in: employeeIds }, account: { status: 'ACTIVE' } },
        select: { id: true },
      }),
    ]);
    const known = new Set([...roles, ...employees].map((r) => r.id));
    const errors = input.steps.flatMap((s, i) => {
      if (s.roleId && !known.has(s.roleId))
        return [{ path: `steps.${i}.roleId`, message: 'Unknown role' }];
      if (s.employeeId && !known.has(s.employeeId))
        return [{ path: `steps.${i}.employeeId`, message: 'Choose an active employee' }];
      return [];
    });
    if (errors.length) throw new ValidationError(errors);
  }

  private chainView(c: ChainRow): ApprovalChainView {
    return {
      id: c.id,
      name: c.name,
      isDefault: c.isDefault,
      steps: c.steps.map((s) => ({
        kind: s.kind,
        roleId: s.roleId,
        roleName: s.role?.name ?? null,
        employeeId: s.employeeId,
        employeeName: s.employee ? `${s.employee.firstName} ${s.employee.lastName}` : null,
      })),
    };
  }
}
