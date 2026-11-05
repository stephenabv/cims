import { Injectable } from '@nestjs/common';
import type { DepartmentInput, PositionInput } from '@cims/shared';
import { NotFoundError, ValidationError } from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/** Departments and positions (reference data for employee records). */
@Injectable()
export class OrgService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listDepartments() {
    const rows = await this.prisma.department.findMany({
      orderBy: { name: 'asc' },
      include: {
        head: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { employees: true } },
      },
    });
    return rows.map(({ head, _count, ...d }) => ({
      ...d,
      head: head ? { id: head.id, fullName: `${head.firstName} ${head.lastName}` } : null,
      employeeCount: _count.employees,
    }));
  }

  createDepartment(actor: AuthContext, input: DepartmentInput, client: ClientInfo) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertHead(tx, input.headId);
      const dept = await tx.department.create({
        data: {
          code: input.code,
          name: input.name,
          headId: input.headId ?? null,
          isActive: input.isActive,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'department.create',
          entityType: 'department',
          entityId: dept.id,
          after: input,
          client,
        },
        tx,
      );
      return dept;
    });
  }

  updateDepartment(
    actor: AuthContext,
    id: string,
    input: Partial<DepartmentInput>,
    client: ClientInfo,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.department.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Department');
      await this.assertHead(tx, input.headId);
      const dept = await tx.department.update({ where: { id }, data: input });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'department.update',
          entityType: 'department',
          entityId: id,
          before,
          after: input,
          client,
        },
        tx,
      );
      return dept;
    });
  }

  listPositions() {
    return this.prisma.position.findMany({
      orderBy: [{ title: 'asc' }],
      include: { department: { select: { id: true, name: true } } },
    });
  }

  createPosition(actor: AuthContext, input: PositionInput, client: ClientInfo) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertDepartment(tx, input.departmentId);
      const pos = await tx.position.create({
        data: {
          title: input.title,
          departmentId: input.departmentId ?? null,
          isActive: input.isActive,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'position.create',
          entityType: 'position',
          entityId: pos.id,
          after: input,
          client,
        },
        tx,
      );
      return pos;
    });
  }

  updatePosition(
    actor: AuthContext,
    id: string,
    input: Partial<PositionInput>,
    client: ClientInfo,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.position.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('Position');
      await this.assertDepartment(tx, input.departmentId);
      const pos = await tx.position.update({ where: { id }, data: input });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'position.update',
          entityType: 'position',
          entityId: id,
          before,
          after: input,
          client,
        },
        tx,
      );
      return pos;
    });
  }

  private async assertHead(tx: PrismaTx, headId: string | null | undefined): Promise<void> {
    if (!headId) return;
    const head = await tx.employee.findUnique({
      where: { id: headId },
      select: { account: { select: { status: true } } },
    });
    if (!head || head.account?.status !== 'ACTIVE')
      throw new ValidationError([
        { path: 'headId', message: 'Department head must be an active employee' },
      ]);
  }

  private async assertDepartment(
    tx: PrismaTx,
    departmentId: string | null | undefined,
  ): Promise<void> {
    if (departmentId && !(await tx.department.findUnique({ where: { id: departmentId } }))) {
      throw new ValidationError([{ path: 'departmentId', message: 'Unknown department' }]);
    }
  }
}
