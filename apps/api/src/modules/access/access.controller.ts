import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ALL_PERMISSION_CODES, PERMISSIONS, type PermissionCode } from '@cims/shared';
import { z } from 'zod';
import {
  Authenticated,
  CurrentAuth,
  RequirePermissions,
} from '../../common/decorators/auth.decorators';
import { type AuthContext, clientInfo } from '../../common/http/request-context';
import { ForbiddenError } from '../../common/errors/app-error';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AccessService } from './access.service';

const permissionList = z
  .array(z.enum(ALL_PERMISSION_CODES as [PermissionCode, ...PermissionCode[]]))
  .max(200);

const createRoleSchema = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{1,49}$/, 'Use letters, digits and underscores'),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  requiresMfa: z.boolean().default(false),
  permissions: permissionList.default([]),
});

const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    requiresMfa: z.boolean().optional(),
    permissions: permissionList.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

@Controller('access')
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get('permissions')
  @RequirePermissions(PERMISSIONS.ACCESS_MANAGE)
  permissions() {
    return this.access.listPermissions();
  }

  @Get('roles')
  @RequirePermissions(PERMISSIONS.ACCESS_MANAGE)
  roles() {
    return this.access.listRoles();
  }

  @Get('roles/assignable')
  @Authenticated()
  assignable(@CurrentAuth() auth: AuthContext) {
    if (
      !auth.permissions.has(PERMISSIONS.EMPLOYEES_CREATE) &&
      !auth.permissions.has(PERMISSIONS.EMPLOYEES_EDIT_EMPLOYMENT) &&
      !auth.permissions.has(PERMISSIONS.ACCESS_MANAGE)
    ) {
      throw new ForbiddenError();
    }
    return this.access.listAssignableRoles(auth);
  }

  @Post('roles')
  @RequirePermissions(PERMISSIONS.ACCESS_MANAGE)
  create(
    @Body(new ZodValidationPipe(createRoleSchema)) body: z.infer<typeof createRoleSchema>,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.access.createRole(auth, body, clientInfo(req));
  }

  @Patch('roles/:id')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.ACCESS_MANAGE)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: z.infer<typeof updateRoleSchema>,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<void> {
    await this.access.updateRole(auth, id, body, clientInfo(req));
  }
}
