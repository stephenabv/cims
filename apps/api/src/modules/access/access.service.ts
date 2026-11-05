import { Injectable } from '@nestjs/common';
import { ALL_PERMISSION_CODES, type PermissionCode } from '@cims/shared';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/app-error';
import type { AuthContext, ClientInfo } from '../../common/http/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';

export interface CreateRoleInput {
  key: string;
  name: string;
  description?: string;
  requiresMfa: boolean;
  permissions: PermissionCode[];
}

/** Runtime-configurable roles (spec §2: new roles without structural changes). */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  listPermissions() {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }

  async listRoles() {
    const roles = await this.prisma.role.findMany({
      orderBy: { name: 'asc' },
      include: {
        permissions: { select: { permissionCode: true } },
        _count: { select: { users: true } },
      },
    });
    return roles.map(({ permissions, _count, ...r }) => ({
      ...r,
      permissions: permissions.map((p) => p.permissionCode).sort(),
      userCount: _count.users,
    }));
  }

  /** Roles the actor may assign when provisioning or changing roles (see EmployeeAccessPolicy). */
  async listAssignableRoles(actor: AuthContext) {
    const roles = await this.prisma.role.findMany({
      orderBy: { name: 'asc' },
      include: { permissions: { select: { permissionCode: true } } },
    });
    const canManageAccess = actor.permissions.has('access.manage');
    return roles
      .filter(
        (r) =>
          canManageAccess ||
          !(r.requiresMfa || r.permissions.some((p) => p.permissionCode === 'access.manage')),
      )
      .map((r) => ({ id: r.id, key: r.key, name: r.name, requiresMfa: r.requiresMfa }));
  }

  async createRole(actor: AuthContext, input: CreateRoleInput, client: ClientInfo) {
    this.assertKnownPermissions(input.permissions);
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          requiresMfa: input.requiresMfa,
          permissions: {
            create: [...new Set(input.permissions)].map((permissionCode) => ({ permissionCode })),
          },
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'role.create',
          entityType: 'role',
          entityId: role.id,
          after: input,
          client,
        },
        tx,
      );
      return role;
    });
  }

  /**
   * Replaces a role's permission set. Sessions of affected users are revoked so new rights
   * (or removals) take effect immediately rather than at next login.
   */
  async updateRole(
    actor: AuthContext,
    roleId: string,
    input: { name?: string; requiresMfa?: boolean; permissions?: PermissionCode[] },
    client: ClientInfo,
  ) {
    if (input.permissions) this.assertKnownPermissions(input.permissions);
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({
        where: { id: roleId },
        include: { permissions: true },
      });
      if (!role) throw new NotFoundError('Role');
      if (role.isSystem && input.name && input.name !== role.name)
        throw new ConflictError('System roles cannot be renamed');
      if (
        input.permissions &&
        actor.roleKey === role.key &&
        !input.permissions.includes('access.manage')
      ) {
        // Prevent an administrator from locking everyone (including themselves) out of access management.
        throw new ConflictError('You cannot remove access management from your own role');
      }
      const before = {
        name: role.name,
        requiresMfa: role.requiresMfa,
        permissions: role.permissions.map((p) => p.permissionCode).sort(),
      };
      await tx.role.update({
        where: { id: roleId },
        data: { name: input.name, requiresMfa: input.requiresMfa },
      });
      if (input.permissions) {
        await tx.rolePermission.deleteMany({ where: { roleId } });
        await tx.rolePermission.createMany({
          data: [...new Set(input.permissions)].map((permissionCode) => ({
            roleId,
            permissionCode,
          })),
        });
      }
      const users = await tx.userAccount.findMany({ where: { roleId }, select: { id: true } });
      for (const u of users) {
        await this.sessions.revokeAllForUser(
          u.id,
          'role_changed',
          tx,
          u.id === actor.userId ? actor.sessionId : undefined,
        );
      }
      await this.audit.record(
        {
          actorUserId: actor.userId,
          action: 'role.update',
          entityType: 'role',
          entityId: roleId,
          before,
          after: input,
          client,
        },
        tx,
      );
    });
  }

  private assertKnownPermissions(codes: string[]): void {
    const unknown = codes.filter((c) => !(ALL_PERMISSION_CODES as readonly string[]).includes(c));
    if (unknown.length)
      throw new ValidationError(
        unknown.map((c) => ({ path: 'permissions', message: `Unknown permission ${c}` })),
      );
  }
}
