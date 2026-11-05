import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '@cims/shared';
import type { Request } from 'express';
import { SKIP_CSRF } from '../../../common/decorators/auth.decorators';
import { ForbiddenError } from '../../../common/errors/app-error';
import { AuthCookies, CSRF_COOKIE, CSRF_HEADER } from '../auth-cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Signed double-submit CSRF check on every state-changing request (including login). */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cookies: AuthCookies,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;
    const cookie = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
    const header = req.header(CSRF_HEADER);
    if (!this.cookies.isValidCsrf(cookie, header)) {
      throw new ForbiddenError('Missing or invalid CSRF token', ERROR_CODES.CSRF_INVALID);
    }
    return true;
  }
}
