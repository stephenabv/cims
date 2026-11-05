import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, type PermissionCode } from '@cims/shared';
import {
  ALLOW_MFA_PENDING,
  ALLOW_PASSWORD_CHANGE_PENDING,
  IS_AUTHENTICATED,
  IS_PUBLIC,
  REQUIRED_PERMISSIONS,
} from '../../../common/decorators/auth.decorators';
import { ForbiddenError, UnauthenticatedError } from '../../../common/errors/app-error';
import type { CimsRequest } from '../../../common/http/request-context';
import { SESSION_COOKIE } from '../auth-cookies';
import { SessionService } from '../session.service';

/**
 * Global, deny-by-default authentication + authorization guard.
 * A route must declare `@Public()`, `@Authenticated()` or `@RequirePermissions()`; a route with
 * none of these is rejected so that a forgotten decorator can never expose an endpoint.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T | undefined>(key, targets);
    const req = context.switchToHttp().getRequest<CimsRequest>();

    if (meta<boolean>(IS_PUBLIC)) return true;

    if (!meta<boolean>(IS_AUTHENTICATED)) {
      this.logger.error({ path: req.path }, 'Route has no access metadata; denying by default');
      throw new ForbiddenError();
    }

    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const auth = token ? await this.sessions.resolve(token) : null;
    if (!auth) throw new UnauthenticatedError();
    req.auth = auth;

    if (!auth.mfaVerified && !meta<boolean>(ALLOW_MFA_PENDING)) {
      throw new UnauthenticatedError(ERROR_CODES.MFA_REQUIRED, 'Two-factor verification required');
    }
    if (auth.mustChangePassword && !meta<boolean>(ALLOW_PASSWORD_CHANGE_PENDING)) {
      throw new ForbiddenError(
        'You must change your password before continuing',
        ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
      );
    }

    const required = meta<PermissionCode[]>(REQUIRED_PERMISSIONS) ?? [];
    if (!required.every((p) => auth.permissions.has(p))) throw new ForbiddenError();
    return true;
  }
}
