import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  type CompensationListQuery,
  type CompensationProfileInput,
  type EmployeePayItemInput,
  type EndPayItemInput,
  type PayItemTypeInput,
  type PayrollPreviewQuery,
  PERMISSIONS,
  type UndertimePolicyInput,
  compensationListQuerySchema,
  compensationProfileSchema,
  employeePayItemSchema,
  endPayItemSchema,
  payItemTypeSchema,
  payrollPreviewQuerySchema,
  undertimePolicySchema,
} from '@cims/shared';
import {
  Authenticated,
  CurrentAuth,
  RequirePermissions,
} from '../../common/decorators/auth.decorators';
import { ForbiddenError } from '../../common/errors/app-error';
import { type AuthContext, clientInfo } from '../../common/http/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CompensationService } from './compensation.service';
import { PayrollConfigService } from './payroll-config.service';

const uuid = new ParseUUIDPipe();

/** Policies and item types are read by whoever sets pay, and changed by payroll configurers. */
function assertCanReadSetup(auth: AuthContext): void {
  if (
    !auth.permissions.has(PERMISSIONS.PAYROLL_CONFIGURE) &&
    !auth.permissions.has(PERMISSIONS.COMPENSATION_VIEW)
  )
    throw new ForbiddenError();
}

@Controller('payroll')
export class PayrollSetupController {
  constructor(private readonly config: PayrollConfigService) {}

  @Get('undertime-policies')
  @Authenticated()
  policies(@CurrentAuth() auth: AuthContext) {
    assertCanReadSetup(auth);
    return this.config.policies();
  }

  @Post('undertime-policies')
  @RequirePermissions(PERMISSIONS.PAYROLL_CONFIGURE)
  createPolicy(
    @Body(new ZodValidationPipe(undertimePolicySchema)) body: UndertimePolicyInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.config.savePolicy(auth, null, body, clientInfo(req));
  }

  @Put('undertime-policies/:id')
  @RequirePermissions(PERMISSIONS.PAYROLL_CONFIGURE)
  updatePolicy(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(undertimePolicySchema)) body: UndertimePolicyInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.config.savePolicy(auth, id, body, clientInfo(req));
  }

  @Post('undertime-policies/:id/default')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.PAYROLL_CONFIGURE)
  makeDefault(
    @Param('id', uuid) id: string,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.config.makeDefaultPolicy(auth, id, clientInfo(req));
  }

  @Get('item-types')
  @Authenticated()
  itemTypes(@CurrentAuth() auth: AuthContext) {
    assertCanReadSetup(auth);
    return this.config.itemTypes();
  }

  @Post('item-types')
  @RequirePermissions(PERMISSIONS.PAYROLL_CONFIGURE)
  createItemType(
    @Body(new ZodValidationPipe(payItemTypeSchema)) body: PayItemTypeInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.config.saveItemType(auth, null, body, clientInfo(req));
  }

  @Put('item-types/:id')
  @RequirePermissions(PERMISSIONS.PAYROLL_CONFIGURE)
  updateItemType(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(payItemTypeSchema)) body: PayItemTypeInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.config.saveItemType(auth, id, body, clientInfo(req));
  }
}

/** Individual pay terms. Reads need payroll.compensation.view; changes need .edit. */
@Controller('payroll/compensation')
export class CompensationController {
  constructor(private readonly compensation: CompensationService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.COMPENSATION_VIEW)
  list(@Query(new ZodValidationPipe(compensationListQuerySchema)) q: CompensationListQuery) {
    return this.compensation.list(q);
  }

  @Get(':employeeId')
  @RequirePermissions(PERMISSIONS.COMPENSATION_VIEW)
  overview(
    @Param('employeeId', uuid) employeeId: string,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.compensation.overview(auth, employeeId, clientInfo(req));
  }

  @Get(':employeeId/preview')
  @RequirePermissions(PERMISSIONS.COMPENSATION_VIEW)
  preview(
    @Param('employeeId', uuid) employeeId: string,
    @Query(new ZodValidationPipe(payrollPreviewQuerySchema)) q: PayrollPreviewQuery,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.compensation.preview(auth, employeeId, q.from, q.to, clientInfo(req));
  }

  @Post(':employeeId/profiles')
  @RequirePermissions(PERMISSIONS.COMPENSATION_VIEW, PERMISSIONS.COMPENSATION_EDIT)
  addProfile(
    @Param('employeeId', uuid) employeeId: string,
    @Body(new ZodValidationPipe(compensationProfileSchema)) body: CompensationProfileInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.compensation.addProfile(auth, employeeId, body, clientInfo(req));
  }

  @Delete('profiles/:id')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.COMPENSATION_VIEW, PERMISSIONS.COMPENSATION_EDIT)
  async removeProfile(
    @Param('id', uuid) id: string,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    await this.compensation.removeProfile(auth, id, clientInfo(req));
  }

  @Post(':employeeId/items')
  @RequirePermissions(PERMISSIONS.COMPENSATION_VIEW, PERMISSIONS.COMPENSATION_EDIT)
  addItem(
    @Param('employeeId', uuid) employeeId: string,
    @Body(new ZodValidationPipe(employeePayItemSchema)) body: EmployeePayItemInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.compensation.addItem(auth, employeeId, body, clientInfo(req));
  }

  @Post('items/:id/end')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.COMPENSATION_VIEW, PERMISSIONS.COMPENSATION_EDIT)
  endItem(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(endPayItemSchema)) body: EndPayItemInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.compensation.endItem(auth, id, body, clientInfo(req));
  }

  @Delete('items/:id')
  @HttpCode(204)
  @RequirePermissions(PERMISSIONS.COMPENSATION_VIEW, PERMISSIONS.COMPENSATION_EDIT)
  async removeItem(
    @Param('id', uuid) id: string,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    await this.compensation.removeItem(auth, id, clientInfo(req));
  }
}
