import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountCredentialsService } from './account-credentials.service';
import { AccountCredentialsController, AuthController } from './auth.controller';
import { AuthCookies } from './auth-cookies';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';
import { CsrfGuard } from './guards/csrf.guard';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

@Module({
  controllers: [AuthController, AccountCredentialsController],
  providers: [
    AuthService,
    AccountCredentialsService,
    SessionService,
    TotpService,
    AuthCookies,
    // Order matters: CSRF is rejected before any session lookup happens.
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService, AuthCookies],
})
export class AuthModule {}
