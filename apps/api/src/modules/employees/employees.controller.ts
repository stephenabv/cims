import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  type ChangeRoleInput,
  type DepartmentInput,
  type EmployeeListQuery,
  LIFECYCLE_ACTIONS,
  type LifecycleAction,
  type LifecycleInput,
  PERMISSIONS,
  type PositionInput,
  type ProvisionEmployeeInput,
  type UpdateEmploymentInput,
  type UpdatePersonalDetailsInput,
  changeRoleSchema,
  departmentSchema,
  employeeListQuerySchema,
  lifecycleSchema,
  positionSchema,
  provisionEmployeeSchema,
  updateEmploymentSchema,
  updatePersonalDetailsSchema,
} from '@cims/shared';
import { z } from 'zod';
import {
  Authenticated,
  CurrentAuth,
  RequirePermissions,
} from '../../common/decorators/auth.decorators';
import { type AuthContext, clientInfo } from '../../common/http/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { EmployeesService } from './employees.service';
import { OrgService } from './org.service';

const lifecycleActionPipe = new ZodValidationPipe(z.enum(LIFECYCLE_ACTIONS));
const uuid = new ParseUUIDPipe();

@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  /** Scope is applied in the service: all, managed departments, or self. */
  @Get()
  @Authenticated()
  list(
    @Query(new ZodValidationPipe(employeeListQuerySchema)) query: EmployeeListQuery,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.employees.list(auth, query);
  }

  @Get('me')
  @Authenticated()
  me(@CurrentAuth() auth: AuthContext) {
    return this.employees.get(auth, auth.employeeId);
  }

  @Get(':id')
  @Authenticated()
  get(@Param('id', uuid) id: string, @CurrentAuth() auth: AuthContext) {
    return this.employees.get(auth, id);
  }

  @Get(':id/history')
  @Authenticated()
  history(@Param('id', uuid) id: string, @CurrentAuth() auth: AuthContext) {
    return this.employees.history(auth, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.EMPLOYEES_CREATE)
  provision(
    @Body(new ZodValidationPipe(provisionEmployeeSchema)) body: ProvisionEmployeeInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.employees.provision(auth, body, clientInfo(req));
  }

  /** Self-service or `employees.edit.personal`; checked in the service. */
  @Patch(':id/personal')
  @Authenticated()
  updatePersonal(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(updatePersonalDetailsSchema)) body: UpdatePersonalDetailsInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.employees.updatePersonal(auth, id, body, clientInfo(req));
  }

  @Patch(':id/employment')
  @RequirePermissions(PERMISSIONS.EMPLOYEES_EDIT_EMPLOYMENT)
  updateEmployment(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(updateEmploymentSchema)) body: UpdateEmploymentInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.employees.updateEmployment(auth, id, body, clientInfo(req));
  }

  /** Requires `access.manage` or `employees.edit.employment` (checked in the service). */
  @Post(':id/role')
  @HttpCode(200)
  @Authenticated()
  changeRole(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(changeRoleSchema)) body: ChangeRoleInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.employees.changeRole(auth, id, body, clientInfo(req));
  }

  @Post(':id/lifecycle/:action')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.EMPLOYEES_LIFECYCLE)
  lifecycle(
    @Param('id', uuid) id: string,
    @Param('action', lifecycleActionPipe) action: LifecycleAction,
    @Body(new ZodValidationPipe(lifecycleSchema)) body: LifecycleInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.employees.changeLifecycle(auth, id, action, body.reason, clientInfo(req));
  }
}

@Controller('org')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  /** Reference data needed by any signed-in user (e.g. to read their profile). */
  @Get('departments')
  @Authenticated()
  departments() {
    return this.org.listDepartments();
  }

  @Post('departments')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  createDepartment(
    @Body(new ZodValidationPipe(departmentSchema)) body: DepartmentInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.org.createDepartment(auth, body, clientInfo(req));
  }

  @Patch('departments/:id')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  updateDepartment(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(departmentSchema.partial())) body: Partial<DepartmentInput>,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.org.updateDepartment(auth, id, body, clientInfo(req));
  }

  @Get('positions')
  @Authenticated()
  positions() {
    return this.org.listPositions();
  }

  @Post('positions')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  createPosition(
    @Body(new ZodValidationPipe(positionSchema)) body: PositionInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.org.createPosition(auth, body, clientInfo(req));
  }

  @Patch('positions/:id')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  updatePosition(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(positionSchema.partial())) body: Partial<PositionInput>,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.org.updatePosition(auth, id, body, clientInfo(req));
  }
}
