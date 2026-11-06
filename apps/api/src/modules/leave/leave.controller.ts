import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  type ApplyLeaveInput,
  type ApprovalChainInput,
  type CancelLeaveInput,
  type LeaveBalanceInput,
  type LeaveDecisionInput,
  type LeavePreviewInput,
  type LeaveRequestQuery,
  type LeaveTypeInput,
  type MyLeaveQuery,
  type PaginationInput,
  PERMISSIONS,
  type WithdrawLeaveInput,
  applyLeaveSchema,
  approvalChainSchema,
  cancelLeaveSchema,
  leaveBalanceSchema,
  leaveDecisionSchema,
  leavePreviewSchema,
  leaveRequestQuerySchema,
  leaveTypeSchema,
  myLeaveQuerySchema,
  paginationSchema,
  withdrawLeaveSchema,
} from '@cims/shared';
import {
  Authenticated,
  CurrentAuth,
  RequirePermissions,
} from '../../common/decorators/auth.decorators';
import { ForbiddenError } from '../../common/errors/app-error';
import { type AuthContext, clientInfo } from '../../common/http/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AttendanceQueryService } from '../attendance/attendance-query.service';
import { LeaveConfigService } from './leave-config.service';
import { LeaveRequestService } from './leave-request.service';

const uuid = new ParseUUIDPipe();
const year = new ParseIntPipe();

/** Leave self-service and approvals. Per-request rules (approver, owner, scope) live in the service. */
@Controller('leave')
export class LeaveController {
  constructor(
    private readonly requests: LeaveRequestService,
    private readonly config: LeaveConfigService,
    private readonly attendance: AttendanceQueryService,
  ) {}

  @Get('types')
  @Authenticated()
  types() {
    return this.config.types(false);
  }

  @Get('balances/me/:year')
  @Authenticated()
  myBalances(@Param('year', year) y: number, @CurrentAuth() auth: AuthContext) {
    return this.config.balances(auth.employeeId, y);
  }

  @Get('balances/employees/:id/:year')
  @Authenticated()
  async employeeBalances(
    @Param('id', uuid) id: string,
    @Param('year', year) y: number,
    @CurrentAuth() auth: AuthContext,
  ) {
    if (
      id !== auth.employeeId &&
      !auth.permissions.has(PERMISSIONS.LEAVE_CONFIGURE) &&
      !auth.permissions.has(PERMISSIONS.LEAVE_VIEW_ALL)
    )
      throw new ForbiddenError();
    await this.attendance.assertCanViewEmployee(auth, id);
    return this.config.balances(id, y);
  }

  @Post('preview')
  @HttpCode(200)
  @Authenticated()
  preview(
    @Body(new ZodValidationPipe(leavePreviewSchema)) body: LeavePreviewInput,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.requests.preview(auth, body);
  }

  @Post('requests')
  @Authenticated()
  apply(
    @Body(new ZodValidationPipe(applyLeaveSchema)) body: ApplyLeaveInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.requests.apply(auth, body, clientInfo(req));
  }

  @Get('requests/mine')
  @Authenticated()
  mine(
    @Query(new ZodValidationPipe(myLeaveQuerySchema)) q: MyLeaveQuery,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.requests.mine(auth, q);
  }

  /** Supervisors and department heads approve without a special permission (spec §3.3). */
  @Get('requests/approvals')
  @Authenticated()
  approvals(
    @Query(new ZodValidationPipe(paginationSchema)) q: PaginationInput,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.requests.approvals(auth, q);
  }

  @Get('requests')
  @Authenticated()
  list(
    @Query(new ZodValidationPipe(leaveRequestQuerySchema)) q: LeaveRequestQuery,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.requests.list(auth, q);
  }

  @Get('requests/:id')
  @Authenticated()
  get(@Param('id', uuid) id: string, @CurrentAuth() auth: AuthContext) {
    return this.requests.get(auth, id);
  }

  @Post('requests/:id/decide')
  @HttpCode(200)
  @Authenticated()
  decide(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(leaveDecisionSchema)) body: LeaveDecisionInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.requests.decide(auth, id, body, clientInfo(req));
  }

  @Post('requests/:id/withdraw')
  @HttpCode(200)
  @Authenticated()
  withdraw(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(withdrawLeaveSchema)) body: WithdrawLeaveInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.requests.withdraw(auth, id, body, clientInfo(req));
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.LEAVE_CANCEL_ANY)
  cancel(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(cancelLeaveSchema)) body: CancelLeaveInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.requests.cancel(auth, id, body, clientInfo(req));
  }
}

/** Leave configuration: types, approval chains and allotments. */
@Controller('leave/config')
@RequirePermissions(PERMISSIONS.LEAVE_CONFIGURE)
export class LeaveConfigController {
  constructor(private readonly config: LeaveConfigService) {}

  @Get('types')
  types() {
    return this.config.types(true);
  }

  @Post('types')
  createType(
    @Body(new ZodValidationPipe(leaveTypeSchema)) body: LeaveTypeInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.config.saveType(auth, null, body, clientInfo(req));
  }

  @Put('types/:id')
  updateType(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(leaveTypeSchema)) body: LeaveTypeInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.config.saveType(auth, id, body, clientInfo(req));
  }

  /** Roles that can be named as an approval step. */
  @Get('roles')
  roles() {
    return this.config.roles();
  }

  @Get('chains')
  chains() {
    return this.config.chains();
  }

  @Post('chains')
  createChain(
    @Body(new ZodValidationPipe(approvalChainSchema)) body: ApprovalChainInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.config.saveChain(auth, null, body, clientInfo(req));
  }

  @Put('chains/:id')
  updateChain(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(approvalChainSchema)) body: ApprovalChainInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.config.saveChain(auth, id, body, clientInfo(req));
  }

  @Put('balances')
  @HttpCode(204)
  async setBalance(
    @Body(new ZodValidationPipe(leaveBalanceSchema)) body: LeaveBalanceInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<void> {
    await this.config.setBalance(auth, body, clientInfo(req));
  }
}
