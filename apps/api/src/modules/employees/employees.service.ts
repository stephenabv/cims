import { Injectable, Logger } from '@nestjs/common';
import {
  type ChangeRoleInput,
  type EmployeeChange,
  type EmployeeDetail,
  type EmployeeListQuery,
  type EmployeeSummary,
  type LifecycleAction,
  type PaginatedResult,
  PERMISSIONS,
  type ProvisionEmployeeInput,
  type UpdateEmploymentInput,
  type UpdatePersonalDetailsInput,
} from '@cims/shared';
import { type Prisma } from '@prisma/client';
import { ConflictError, ForbiddenError, ValidationError } from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { HashingService } from '../../infrastructure/crypto/hashing.service';
import { Mailer } from '../../infrastructure/mail/mailer';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { generatePin } from '../auth/account-credentials.service';
import { generateTemporaryPassword } from '../auth/domain/recovery-codes';
import { SessionService } from '../auth/session.service';
import { SettingsService } from '../settings/settings.service';
import { nextAccountStatus, revokesSessions } from './domain/account-lifecycle';
import { type FieldChange, diffFields } from './domain/change-diff';
import { EmployeeAccessPolicy } from './employee-access.policy';

const detailInclude = {
  department: { select: { id: true, name: true } },
  position: { select: { id: true, title: true } },
  supervisor: { select: { id: true, firstName: true, lastName: true, accountNumber: true } },
  account: {
    select: {
      id: true,
      status: true,
      role: {
        select: {
          id: true,
          key: true,
          name: true,
          requiresMfa: true,
          permissions: { select: { permissionCode: true } },
        },
      },
    },
  },
} satisfies Prisma.EmployeeInclude;

type EmployeeRecord = Prisma.EmployeeGetPayload<{ include: typeof detailInclude }>;

const PERSONAL_FIELDS = [
  'contactNumber',
  'residentialAddress',
  'emergencyContactName',
  'emergencyContactRelationship',
  'emergencyContactPhone',
] as const;
const EMPLOYMENT_FIELDS = [
  'firstName',
  'middleName',
  'lastName',
  'suffix',
  'companyEmail',
  'departmentId',
  'positionId',
  'supervisorId',
  'classification',
  'employmentStatus',
  'dateHired',
] as const;

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

export interface ProvisionResult {
  employee: EmployeeDetail;
  credentialsDelivered: boolean;
}

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: EmployeeAccessPolicy,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly sessions: SessionService,
    private readonly hashing: HashingService,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
  ) {}

  // ───────────── Queries ─────────────

  async list(
    actor: AuthContext,
    query: EmployeeListQuery,
  ): Promise<PaginatedResult<EmployeeSummary>> {
    const scope = await this.policy.viewScope(actor);
    const and: Prisma.EmployeeWhereInput[] = [];
    if (scope.kind === 'departments')
      and.push({ OR: [{ departmentId: { in: scope.departmentIds } }, { id: actor.employeeId }] });
    if (scope.kind === 'self') and.push({ id: actor.employeeId });
    if (query.departmentId) and.push({ departmentId: query.departmentId });
    if (query.accountStatus) and.push({ account: { status: query.accountStatus } });
    if (query.search) {
      const term = query.search;
      and.push({
        OR: [
          { firstName: { contains: term, mode: 'insensitive' } },
          { lastName: { contains: term, mode: 'insensitive' } },
          { accountNumber: { contains: term, mode: 'insensitive' } },
          { companyEmail: { contains: term, mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.EmployeeWhereInput = { AND: and };
    const orderBy: Prisma.EmployeeOrderByWithRelationInput[] =
      query.sort === 'accountNumber'
        ? [{ accountNumber: 'asc' }]
        : query.sort === 'dateHired'
          ? [{ dateHired: 'desc' }, { lastName: 'asc' }]
          : [{ lastName: 'asc' }, { firstName: 'asc' }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        orderBy,
        include: detailInclude,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.employee.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.toSummary(r)),
      meta: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  async get(actor: AuthContext, id: string): Promise<EmployeeDetail> {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: detailInclude,
    });
    await this.policy.assertCanView(actor, employee);
    return this.toDetail(employee!, actor);
  }

  async history(actor: AuthContext, id: string): Promise<EmployeeChange[]> {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, departmentId: true },
    });
    await this.policy.assertCanView(actor, employee);
    const rows = await this.prisma.employeeChangeHistory.findMany({
      where: { employeeId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const actorIds = [...new Set(rows.map((r) => r.changedById).filter((v): v is string => !!v))];
    const actors = await this.prisma.userAccount.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, employee: { select: { firstName: true, lastName: true } } },
    });
    const names = new Map(actors.map((a) => [a.id, fullName(a.employee)]));
    return rows.map((r) => ({
      id: r.id,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      reason: r.reason,
      changedBy: r.changedById
        ? { id: r.changedById, fullName: names.get(r.changedById) ?? 'Unknown' }
        : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ───────────── Provisioning (§3.10) ─────────────

  async provision(
    actor: AuthContext,
    input: ProvisionEmployeeInput,
    client: ClientInfo,
  ): Promise<ProvisionResult> {
    await this.assertAllowedEmailDomain(input.companyEmail);
    const role = await this.prisma.role.findUnique({
      where: { id: input.roleId },
      include: { permissions: { select: { permissionCode: true } } },
    });
    if (!role) throw new ValidationError([{ path: 'roleId', message: 'Unknown role' }]);
    this.policy.assertCanAssignRole(actor, role);

    const tempPassword = generateTemporaryPassword();
    const pin = generatePin();
    const [passwordHash, pinHash] = await Promise.all([
      this.hashing.hashSecret(tempPassword),
      this.hashing.hashSecret(pin),
    ]);
    const ttlHours = await this.settings.get('security.tempPasswordTtlHours');
    const tempPasswordExpiresAt = new Date(this.clock.now().getTime() + ttlHours * 3_600_000);

    const employeeId = await this.prisma.$transaction(async (tx) => {
      await this.validateOrgReferences(tx, {
        departmentId: input.departmentId,
        positionId: input.positionId,
        supervisorId: input.supervisorId,
      });
      const [{ nextval }] = await tx.$queryRaw<
        [{ nextval: bigint }]
      >`SELECT nextval('employee_account_number_seq')`;
      const accountNumber = `EMP-${nextval.toString().padStart(6, '0')}`;
      const employee = await tx.employee.create({
        data: {
          accountNumber,
          firstName: input.firstName,
          middleName: input.middleName ?? null,
          lastName: input.lastName,
          suffix: input.suffix ?? null,
          companyEmail: input.companyEmail,
          contactNumber: input.contactNumber ?? null,
          residentialAddress: input.residentialAddress ?? null,
          emergencyContactName: input.emergencyContactName ?? null,
          emergencyContactRelationship: input.emergencyContactRelationship ?? null,
          emergencyContactPhone: input.emergencyContactPhone ?? null,
          departmentId: input.departmentId,
          positionId: input.positionId,
          supervisorId: input.supervisorId,
          classification: input.classification,
          dateHired: toDate(input.dateHired),
          createdById: actor.userId,
        },
      });
      await tx.userAccount.create({
        data: {
          employeeId: employee.id,
          roleId: role.id,
          status: input.activate ? 'ACTIVE' : 'PENDING_ACTIVATION',
          passwordHash,
          mustChangePassword: true,
          tempPasswordExpiresAt,
          pinHash,
        },
      });
      await tx.employeeChangeHistory.create({
        data: {
          employeeId: employee.id,
          field: 'record',
          newValue: 'created',
          changedById: actor.userId,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'employee.provision',
          entityType: 'employee',
          entityId: employee.id,
          after: { ...input, accountNumber, roleKey: role.key },
          client,
        },
        tx,
      );
      return employee.id;
    });

    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: detailInclude,
    });
    const credentialsDelivered = await this.sendWelcome(
      employee,
      tempPassword,
      pin,
      tempPasswordExpiresAt,
    );
    return { employee: this.toDetail(employee, actor), credentialsDelivered };
  }

  // ───────────── Updates ─────────────

  async updatePersonal(
    actor: AuthContext,
    id: string,
    input: UpdatePersonalDetailsInput,
    client: ClientInfo,
  ): Promise<EmployeeDetail> {
    const isSelf = id === actor.employeeId;
    if (!isSelf && !actor.permissions.has(PERMISSIONS.EMPLOYEES_EDIT_PERSONAL)) {
      // Do not reveal whether an out-of-scope record exists.
      const target = await this.prisma.employee.findUnique({
        where: { id },
        select: { id: true, departmentId: true },
      });
      await this.policy.assertCanView(actor, target);
      throw new ForbiddenError();
    }
    const { version, ...changes } = input;
    return this.applyUpdate(
      actor,
      id,
      version,
      changes,
      PERSONAL_FIELDS,
      null,
      client,
      'employee.update_personal',
    );
  }

  async updateEmployment(
    actor: AuthContext,
    id: string,
    input: UpdateEmploymentInput,
    client: ClientInfo,
  ): Promise<EmployeeDetail> {
    const { version, reason, dateHired, ...rest } = input;
    if (rest.companyEmail) await this.assertAllowedEmailDomain(rest.companyEmail);
    const changes: Prisma.EmployeeUncheckedUpdateInput & Record<string, unknown> = {
      ...rest,
      ...(dateHired ? { dateHired: toDate(dateHired) } : {}),
    };
    return this.applyUpdate(
      actor,
      id,
      version,
      changes,
      EMPLOYMENT_FIELDS,
      reason ?? null,
      client,
      'employee.update_employment',
      async (tx) => {
        if (rest.supervisorId === id)
          throw new ValidationError([
            { path: 'supervisorId', message: 'An employee cannot supervise themselves' },
          ]);
        await this.validateOrgReferences(tx, {
          departmentId: rest.departmentId,
          positionId: rest.positionId,
          supervisorId: rest.supervisorId,
        });
        if (rest.supervisorId) await this.assertNoSupervisionCycle(tx, id, rest.supervisorId);
      },
    );
  }

  async changeRole(
    actor: AuthContext,
    id: string,
    input: ChangeRoleInput,
    client: ClientInfo,
  ): Promise<EmployeeDetail> {
    if (
      !actor.permissions.has(PERMISSIONS.ACCESS_MANAGE) &&
      !actor.permissions.has(PERMISSIONS.EMPLOYEES_EDIT_EMPLOYMENT)
    )
      throw new ForbiddenError();
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: detailInclude,
    });
    await this.policy.assertCanView(actor, employee);
    const account = employee!.account;
    if (!account) throw new ConflictError('This employee has no system account');
    const role = await this.prisma.role.findUnique({
      where: { id: input.roleId },
      include: { permissions: { select: { permissionCode: true } } },
    });
    if (!role) throw new ValidationError([{ path: 'roleId', message: 'Unknown role' }]);
    this.policy.assertCanManageAccountOf(actor, { employeeId: id, role: account.role });
    // Both the current and the new role must be assignable by the actor.
    this.policy.assertCanAssignRole(actor, account.role);
    this.policy.assertCanAssignRole(actor, role);
    if (role.id === account.role.id) return this.toDetail(employee!, actor);

    await this.prisma.$transaction(async (tx) => {
      await tx.userAccount.update({ where: { id: account.id }, data: { roleId: role.id } });
      await this.sessions.revokeAllForUser(account.id, 'role_changed', tx);
      await tx.employeeChangeHistory.create({
        data: {
          employeeId: id,
          field: 'role',
          oldValue: account.role.key,
          newValue: role.key,
          changedById: actor.userId,
          reason: input.reason,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'employee.change_role',
          entityType: 'employee',
          entityId: id,
          before: { role: account.role.key },
          after: { role: role.key },
          metadata: { reason: input.reason },
          client,
        },
        tx,
      );
    });
    return this.get(actor, id);
  }

  async changeLifecycle(
    actor: AuthContext,
    id: string,
    action: LifecycleAction,
    reason: string,
    client: ClientInfo,
  ): Promise<EmployeeDetail> {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: detailInclude,
    });
    await this.policy.assertCanView(actor, employee);
    const account = employee!.account;
    if (!account) throw new ConflictError('This employee has no system account');
    this.policy.assertCanManageAccountOf(actor, { employeeId: id, role: account.role });

    const next = nextAccountStatus(account.status, action);
    if (!next)
      throw new ConflictError(
        `Cannot ${action} an account that is ${account.status.toLowerCase().replace('_', ' ')}`,
      );

    await this.prisma.$transaction(async (tx) => {
      // Conditional update: a concurrent transition makes this match zero rows.
      const updated = await tx.userAccount.updateMany({
        where: { id: account.id, status: account.status },
        data: { status: next },
      });
      if (updated.count !== 1)
        throw new ConflictError('The account was changed by someone else. Reload and try again.');
      if (revokesSessions(next))
        await this.sessions.revokeAllForUser(account.id, `account_${next.toLowerCase()}`, tx);
      await tx.employeeChangeHistory.create({
        data: {
          employeeId: id,
          field: 'accountStatus',
          oldValue: account.status,
          newValue: next,
          changedById: actor.userId,
          reason,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: `employee.${action}`,
          entityType: 'employee',
          entityId: id,
          before: { status: account.status },
          after: { status: next },
          metadata: { reason },
          client,
        },
        tx,
      );
    });
    return this.get(actor, id);
  }

  // ───────────── helpers ─────────────

  private async applyUpdate(
    actor: AuthContext,
    id: string,
    version: number,
    changes: Record<string, unknown>,
    fields: readonly string[],
    reason: string | null,
    client: ClientInfo,
    action: string,
    validate?: (tx: PrismaTx) => Promise<void>,
  ): Promise<EmployeeDetail> {
    const current = await this.prisma.employee.findUnique({
      where: { id },
      include: detailInclude,
    });
    await this.policy.assertCanView(actor, current);

    await this.prisma.$transaction(async (tx) => {
      if (validate) await validate(tx);
      const diff: FieldChange[] = diffFields(
        current! as unknown as Record<string, unknown>,
        changes,
        fields as string[],
      );
      if (diff.length === 0) return;
      const data = Object.fromEntries(
        diff.map((d) => [d.field, changes[d.field]]),
      ) as Prisma.EmployeeUncheckedUpdateManyInput;
      // Optimistic concurrency: the update only applies if nobody saved in between.
      const res = await tx.employee.updateMany({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
      });
      if (res.count !== 1)
        throw new ConflictError(
          'This record was changed by someone else. Reload to see the latest version.',
        );
      const readable = await this.describeReferences(tx, diff);
      await tx.employeeChangeHistory.createMany({
        data: readable.map((d) => ({ employeeId: id, ...d, changedById: actor.userId, reason })),
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action,
          entityType: 'employee',
          entityId: id,
          before: Object.fromEntries(diff.map((d) => [d.field, d.oldValue])),
          after: Object.fromEntries(diff.map((d) => [d.field, d.newValue])),
          metadata: reason ? { reason } : undefined,
          client,
        },
        tx,
      );
    });
    return this.get(actor, id);
  }

  /** History stores names rather than ids for reference fields so it stays readable over time. */
  private async describeReferences(tx: PrismaTx, diff: FieldChange[]): Promise<FieldChange[]> {
    const label = async (field: string, id: string | null): Promise<string | null> => {
      if (!id) return null;
      if (field === 'departmentId')
        return (
          (await tx.department.findUnique({ where: { id }, select: { name: true } }))?.name ?? id
        );
      if (field === 'positionId')
        return (
          (await tx.position.findUnique({ where: { id }, select: { title: true } }))?.title ?? id
        );
      if (field === 'supervisorId') {
        const e = await tx.employee.findUnique({
          where: { id },
          select: { firstName: true, lastName: true, accountNumber: true },
        });
        return e ? `${fullName(e)} (${e.accountNumber})` : id;
      }
      return id;
    };
    return Promise.all(
      diff.map(async (d) =>
        ['departmentId', 'positionId', 'supervisorId'].includes(d.field)
          ? {
              ...d,
              oldValue: await label(d.field, d.oldValue),
              newValue: await label(d.field, d.newValue),
            }
          : d,
      ),
    );
  }

  private async assertAllowedEmailDomain(email: string): Promise<void> {
    const domains = await this.settings.get('company.allowedEmailDomains');
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain || !domains.includes(domain)) {
      throw new ValidationError([
        {
          path: 'companyEmail',
          message: `Only company email addresses are allowed (${domains.join(', ')})`,
        },
      ]);
    }
  }

  private async validateOrgReferences(
    tx: PrismaTx,
    refs: {
      departmentId?: string | null;
      positionId?: string | null;
      supervisorId?: string | null;
    },
  ): Promise<void> {
    const errors: { path: string; message: string }[] = [];
    if (
      refs.departmentId &&
      !(await tx.department.findFirst({ where: { id: refs.departmentId, isActive: true } }))
    )
      errors.push({ path: 'departmentId', message: 'Unknown or inactive department' });
    if (
      refs.positionId &&
      !(await tx.position.findFirst({ where: { id: refs.positionId, isActive: true } }))
    )
      errors.push({ path: 'positionId', message: 'Unknown or inactive position' });
    if (refs.supervisorId) {
      const sup = await tx.employee.findUnique({
        where: { id: refs.supervisorId },
        select: { account: { select: { status: true } } },
      });
      if (!sup || sup.account?.status === 'DEACTIVATED')
        errors.push({
          path: 'supervisorId',
          message: 'Supervisor must be an existing, non-deactivated employee',
        });
    }
    if (errors.length) throw new ValidationError(errors);
  }

  /** Walks up from the proposed supervisor; reaching `employeeId` would create a reporting loop. */
  private async assertNoSupervisionCycle(
    tx: PrismaTx,
    employeeId: string,
    supervisorId: string,
  ): Promise<void> {
    let cursor: string | null = supervisorId;
    for (let depth = 0; cursor && depth < 100; depth++) {
      if (cursor === employeeId)
        throw new ValidationError([
          { path: 'supervisorId', message: 'This would create a circular reporting line' },
        ]);
      const row: { supervisorId: string | null } | null = await tx.employee.findUnique({
        where: { id: cursor },
        select: { supervisorId: true },
      });
      cursor = row?.supervisorId ?? null;
    }
  }

  private async sendWelcome(
    employee: EmployeeRecord,
    tempPassword: string,
    pin: string,
    expiresAt: Date,
  ): Promise<boolean> {
    try {
      await this.mailer.send({
        to: employee.companyEmail,
        subject: 'Your CIMS account',
        text:
          `Hello ${employee.firstName},\n\nYour CIMS account has been created.\n\n` +
          `Account number: ${employee.accountNumber}\nTemporary password:\n    ${tempPassword}\nAttendance PIN: ${pin}\n\n` +
          `The temporary password expires on ${expiresAt.toISOString()} and must be changed at first sign-in. ` +
          `You can change your PIN from "Sign-in & security".`,
      });
      return true;
    } catch (err) {
      // The account exists; HR/IT can re-issue credentials from the employee page.
      this.logger.error({ err, employeeId: employee.id }, 'Failed to deliver welcome email');
      return false;
    }
  }

  private toSummary(e: EmployeeRecord): EmployeeSummary {
    return {
      id: e.id,
      accountNumber: e.accountNumber,
      fullName: fullName(e),
      companyEmail: e.companyEmail,
      department: e.department,
      position: e.position,
      role: e.account
        ? { id: e.account.role.id, key: e.account.role.key, name: e.account.role.name }
        : null,
      accountStatus: e.account?.status ?? null,
      employmentStatus: e.employmentStatus,
    };
  }

  private toDetail(e: EmployeeRecord, actor: AuthContext): EmployeeDetail {
    const isSelf = e.id === actor.employeeId;
    const can = (p: string) => actor.permissions.has(p as never);
    const targetIsAccessAdmin =
      e.account?.role.permissions.some((p) => p.permissionCode === PERMISSIONS.ACCESS_MANAGE) ??
      false;
    const canManageTarget = !isSelf && (!targetIsAccessAdmin || can(PERMISSIONS.ACCESS_MANAGE));
    return {
      ...this.toSummary(e),
      userId: e.account?.id ?? null,
      firstName: e.firstName,
      middleName: e.middleName,
      lastName: e.lastName,
      suffix: e.suffix,
      contactNumber: e.contactNumber,
      residentialAddress: e.residentialAddress,
      emergencyContactName: e.emergencyContactName,
      emergencyContactRelationship: e.emergencyContactRelationship,
      emergencyContactPhone: e.emergencyContactPhone,
      supervisor: e.supervisor
        ? {
            id: e.supervisor.id,
            fullName: fullName(e.supervisor),
            accountNumber: e.supervisor.accountNumber,
          }
        : null,
      classification: e.classification,
      dateHired: e.dateHired.toISOString().slice(0, 10),
      version: e.version,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
      capabilities: {
        editPersonal: isSelf || can(PERMISSIONS.EMPLOYEES_EDIT_PERSONAL),
        editEmployment: can(PERMISSIONS.EMPLOYEES_EDIT_EMPLOYMENT),
        manageLifecycle: canManageTarget && can(PERMISSIONS.EMPLOYEES_LIFECYCLE) && !!e.account,
        resetCredentials: !isSelf && can(PERMISSIONS.ACCOUNTS_RESET_CREDENTIALS) && !!e.account,
        changeRole:
          canManageTarget &&
          !!e.account &&
          (can(PERMISSIONS.ACCESS_MANAGE) ||
            (can(PERMISSIONS.EMPLOYEES_EDIT_EMPLOYMENT) &&
              !this.policy.isPrivileged(e.account.role))),
      },
    };
  }
}
