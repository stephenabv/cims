import {
  Body,
  Controller,
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
  type MyOvertimeQuery,
  type OvertimeDecisionInput,
  type OvertimePolicy,
  type OvertimeQuery,
  type OvertimeSummaryQuery,
  PERMISSIONS,
  myOvertimeQuerySchema,
  overtimeDecisionSchema,
  overtimePolicySchema,
  overtimeQuerySchema,
  overtimeSummaryQuerySchema,
} from '@cims/shared';
import {
  Authenticated,
  CurrentAuth,
  RequirePermissions,
} from '../../common/decorators/auth.decorators';
import { type AuthContext, clientInfo } from '../../common/http/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { OvertimeService } from './overtime.service';

const uuid = new ParseUUIDPipe();

/**
 * Overtime records and the overtime/undertime monitor. Direct supervisors act without a special
 * permission (spec §3.4 "appropriate supervisor"), so most routes only require a session and the
 * service applies the per-employee scope.
 */
@Controller('overtime')
export class OvertimeController {
  constructor(private readonly overtime: OvertimeService) {}

  @Get('mine')
  @Authenticated()
  mine(
    @Query(new ZodValidationPipe(myOvertimeQuerySchema)) q: MyOvertimeQuery,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.overtime.mine(auth, q);
  }

  @Get('waiting')
  @Authenticated()
  async waiting(@CurrentAuth() auth: AuthContext) {
    return { count: await this.overtime.waitingCount(auth) };
  }

  @Get('summary')
  @Authenticated()
  summary(
    @Query(new ZodValidationPipe(overtimeSummaryQuerySchema)) q: OvertimeSummaryQuery,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.overtime.summary(auth, q);
  }

  @Get('policy')
  @Authenticated()
  policy() {
    return this.overtime.policy();
  }

  @Put('policy')
  @RequirePermissions(PERMISSIONS.PAYROLL_CONFIGURE)
  setPolicy(
    @Body(new ZodValidationPipe(overtimePolicySchema)) body: OvertimePolicy,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.overtime.setPolicy(auth, body);
  }

  @Get()
  @Authenticated()
  list(
    @Query(new ZodValidationPipe(overtimeQuerySchema)) q: OvertimeQuery,
    @CurrentAuth() auth: AuthContext,
  ) {
    return this.overtime.list(auth, q);
  }

  @Get(':id')
  @Authenticated()
  get(@Param('id', uuid) id: string, @CurrentAuth() auth: AuthContext) {
    return this.overtime.get(auth, id);
  }

  @Post(':id/decide')
  @HttpCode(200)
  @Authenticated()
  decide(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(overtimeDecisionSchema)) body: OvertimeDecisionInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ) {
    return this.overtime.decide(auth, id, body, clientInfo(req));
  }
}
