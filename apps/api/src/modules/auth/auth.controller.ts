import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  type ChangePasswordInput,
  type ChangePinInput,
  type CurrentUser,
  type LoginInput,
  type LoginResult,
  type MfaVerifyInput,
  PERMISSIONS,
  type PasswordRecoveryCompleteInput,
  type PasswordRecoveryRequestInput,
  changePasswordSchema,
  changePinSchema,
  loginSchema,
  mfaVerifySchema,
  passwordRecoveryCompleteSchema,
  passwordRecoveryRequestSchema,
} from '@cims/shared';
import { ENV, type Env } from '../../common/config/env';
import {
  AllowMfaPending,
  AllowPasswordChangePending,
  Authenticated,
  CurrentAuth,
  Public,
  RequirePermissions,
} from '../../common/decorators/auth.decorators';
import { type AuthContext, clientInfo } from '../../common/http/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AccountCredentialsService } from './account-credentials.service';
import { AuthCookies } from './auth-cookies';
import { AuthService } from './auth.service';

const STRICT_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: AuthCookies,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Issues the CSRF cookie the SPA must echo on state-changing requests. */
  @Get('csrf')
  @Public()
  csrf(@Res({ passthrough: true }) res: Response): { csrfToken: string } {
    return { csrfToken: this.cookies.issueCsrf(res) };
  }

  @Post('login')
  @HttpCode(200)
  @Public()
  @Throttle(STRICT_THROTTLE)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    const { result, session } = await this.auth.login(body, clientInfo(req));
    this.cookies.setSession(res, session.token, session.expiresAt);
    this.cookies.issueCsrf(res);
    return result;
  }

  @Post('logout')
  @HttpCode(204)
  @Authenticated()
  @AllowMfaPending()
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(auth, clientInfo(req));
    this.cookies.clearSession(res);
  }

  @Get('me')
  @Authenticated()
  @AllowPasswordChangePending()
  me(@CurrentAuth() auth: AuthContext): Promise<CurrentUser> {
    return this.auth.currentUser(auth.userId);
  }

  @Post('mfa/enroll')
  @HttpCode(200)
  @Authenticated()
  @AllowMfaPending()
  startMfaEnrollment(@CurrentAuth() auth: AuthContext) {
    return this.auth.startMfaEnrollment(auth);
  }

  @Post('mfa/enroll/confirm')
  @HttpCode(200)
  @Authenticated()
  @AllowMfaPending()
  @Throttle(STRICT_THROTTLE)
  async confirmMfaEnrollment(
    @Body(new ZodValidationPipe(mfaVerifySchema)) body: MfaVerifyInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ recoveryCodes: string[]; user: CurrentUser }> {
    const { recoveryCodes, session, user } = await this.auth.confirmMfaEnrollment(
      auth,
      body.code,
      clientInfo(req),
    );
    this.cookies.setSession(res, session.token, session.expiresAt);
    return { recoveryCodes, user };
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @Authenticated()
  @AllowMfaPending()
  @Throttle(STRICT_THROTTLE)
  async verifyMfa(
    @Body(new ZodValidationPipe(mfaVerifySchema)) body: MfaVerifyInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CurrentUser> {
    const { session, user } = await this.auth.verifyMfa(auth, body.code, clientInfo(req));
    this.cookies.setSession(res, session.token, session.expiresAt);
    return user;
  }

  @Post('password')
  @HttpCode(204)
  @Authenticated()
  @AllowPasswordChangePending()
  @Throttle(STRICT_THROTTLE)
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.changePassword(auth, body, clientInfo(req));
  }

  @Post('pin')
  @HttpCode(204)
  @Authenticated()
  @Throttle(STRICT_THROTTLE)
  async changePin(
    @Body(new ZodValidationPipe(changePinSchema)) body: ChangePinInput,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.changePin(auth, body, clientInfo(req));
  }

  @Post('password-recovery')
  @HttpCode(202)
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestRecovery(
    @Body(new ZodValidationPipe(passwordRecoveryRequestSchema)) body: PasswordRecoveryRequestInput,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    await this.auth.requestPasswordRecovery(
      body.accountNumber,
      clientInfo(req),
      `${this.env.WEB_ORIGIN}/reset-password`,
    );
    return {
      message: 'If the account exists, a reset link has been sent to its registered company email.',
    };
  }

  @Post('password-recovery/complete')
  @HttpCode(204)
  @Public()
  @Throttle(STRICT_THROTTLE)
  async completeRecovery(
    @Body(new ZodValidationPipe(passwordRecoveryCompleteSchema))
    body: PasswordRecoveryCompleteInput,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.completePasswordRecovery(body, clientInfo(req));
  }
}

@Controller('accounts')
export class AccountCredentialsController {
  constructor(private readonly credentials: AccountCredentialsService) {}

  @Post(':userId/temporary-password')
  @HttpCode(202)
  @RequirePermissions(PERMISSIONS.ACCOUNTS_RESET_CREDENTIALS)
  async issueTemporaryPassword(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<{ expiresAt: string; message: string }> {
    const { expiresAt } = await this.credentials.issueTemporaryPassword(
      auth,
      userId,
      clientInfo(req),
    );
    return {
      expiresAt: expiresAt.toISOString(),
      message: 'A temporary password was sent to the employee’s company email.',
    };
  }

  @Post(':userId/pin-reset')
  @HttpCode(202)
  @RequirePermissions(PERMISSIONS.ACCOUNTS_RESET_CREDENTIALS)
  async resetPin(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    await this.credentials.resetPin(auth, userId, clientInfo(req));
    return { message: 'A new PIN was sent to the employee’s company email.' };
  }
}
