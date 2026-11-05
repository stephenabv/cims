import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import type { PermissionCode } from '@cims/shared';
import type { AuthContext, CimsRequest } from '../http/request-context';

export const IS_PUBLIC = 'cims:isPublic';
export const IS_AUTHENTICATED = 'cims:isAuthenticated';
export const REQUIRED_PERMISSIONS = 'cims:requiredPermissions';
export const ALLOW_PASSWORD_CHANGE_PENDING = 'cims:allowPasswordChangePending';
export const ALLOW_MFA_PENDING = 'cims:allowMfaPending';
export const SKIP_CSRF = 'cims:skipCsrf';

/** No session required. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Any fully authenticated user. */
export const Authenticated = () => SetMetadata(IS_AUTHENTICATED, true);

/** Authenticated user holding ALL listed permissions. */
export const RequirePermissions = (...codes: PermissionCode[]) =>
  applyDecorators(SetMetadata(IS_AUTHENTICATED, true), SetMetadata(REQUIRED_PERMISSIONS, codes));

/** Reachable while the user still has to replace a temporary/expired password. */
export const AllowPasswordChangePending = () => SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING, true);

/** Reachable by a session that has passed the password step but not yet the 2FA step. */
export const AllowMfaPending = () =>
  applyDecorators(
    SetMetadata(ALLOW_MFA_PENDING, true),
    SetMetadata(ALLOW_PASSWORD_CHANGE_PENDING, true),
  );

/** For endpoints that never use cookie credentials (e.g. kiosk device-token endpoints). */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);

export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<CimsRequest>();
    if (!req.auth) {
      // Guard ordering guarantees this never happens on protected routes; fail loudly if it does.
      throw new Error('CurrentAuth used on a route without an authenticated session');
    }
    return req.auth;
  },
);
