import { Injectable } from '@nestjs/common';
import { PERMISSIONS } from '@cims/shared';
import { ForbiddenError, NotFoundError } from '../../common/errors/app-error';
import type { AuthContext } from '../../common/http/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export type ViewScope =
  | { kind: 'all' }
  | { kind: 'departments'; departmentIds: string[] }
  | { kind: 'self' };

export interface RoleLike {
  requiresMfa: boolean;
  permissions: { permissionCode: string }[];
}

/**
 * Data-scope rules for employee records (prevents IDOR regardless of UI):
 * - `employees.view.all` → every employee
 * - `employees.view.department` → employees of departments the actor heads, plus self
 * - otherwise → self only
 */
@Injectable()
export class EmployeeAccessPolicy {
  constructor(private readonly prisma: PrismaService) {}

  async viewScope(actor: AuthContext): Promise<ViewScope> {
    if (actor.permissions.has(PERMISSIONS.EMPLOYEES_VIEW_ALL)) return { kind: 'all' };
    if (actor.permissions.has(PERMISSIONS.EMPLOYEES_VIEW_DEPARTMENT)) {
      const departments = await this.prisma.department.findMany({
        where: { headId: actor.employeeId },
        select: { id: true },
      });
      return { kind: 'departments', departmentIds: departments.map((d) => d.id) };
    }
    return { kind: 'self' };
  }

  canViewWithScope(
    scope: ViewScope,
    actor: AuthContext,
    employee: { id: string; departmentId: string | null },
  ): boolean {
    if (employee.id === actor.employeeId) return true;
    if (scope.kind === 'all') return true;
    return (
      scope.kind === 'departments' &&
      employee.departmentId !== null &&
      scope.departmentIds.includes(employee.departmentId)
    );
  }

  /** Throws NotFound (not Forbidden) for out-of-scope records so their existence is not revealed. */
  async assertCanView(
    actor: AuthContext,
    employee: { id: string; departmentId: string | null } | null,
  ): Promise<void> {
    if (!employee) throw new NotFoundError('Employee');
    const scope = await this.viewScope(actor);
    if (!this.canViewWithScope(scope, actor, employee)) throw new NotFoundError('Employee');
  }

  /**
   * Privileged roles (2FA-required or granting access management) may only be assigned, and their
   * holders only suspended/deactivated, by someone who can manage access. This stops HR from
   * escalating privileges or locking IT out, while IT remains able to provision every role.
   */
  isPrivileged(role: RoleLike): boolean {
    return (
      role.requiresMfa ||
      role.permissions.some((p) => p.permissionCode === PERMISSIONS.ACCESS_MANAGE)
    );
  }

  assertCanAssignRole(actor: AuthContext, role: RoleLike): void {
    if (this.isPrivileged(role) && !actor.permissions.has(PERMISSIONS.ACCESS_MANAGE)) {
      throw new ForbiddenError('Only access administrators can assign privileged roles');
    }
  }

  assertCanManageAccountOf(
    actor: AuthContext,
    target: { employeeId: string; role: RoleLike },
  ): void {
    if (target.employeeId === actor.employeeId)
      throw new ForbiddenError('You cannot perform this action on your own account');
    if (
      target.role.permissions.some((p) => p.permissionCode === PERMISSIONS.ACCESS_MANAGE) &&
      !actor.permissions.has(PERMISSIONS.ACCESS_MANAGE)
    ) {
      throw new ForbiddenError('Only access administrators can manage this account');
    }
  }
}
