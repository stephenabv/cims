import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import { ENV, type Env } from '../../common/config/env';
import { HashingService } from '../../infrastructure/crypto/hashing.service';

export const SESSION_COOKIE = 'cims_session';
export const CSRF_COOKIE = 'cims_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Issues/clears the session cookie and the signed double-submit CSRF cookie. */
@Injectable()
export class AuthCookies {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly hashing: HashingService,
  ) {}

  private base(): CookieOptions {
    return { secure: this.env.COOKIE_SECURE, sameSite: 'lax', path: '/' };
  }

  setSession(res: Response, token: string, expiresAt: Date): void {
    res.cookie(SESSION_COOKIE, token, { ...this.base(), httpOnly: true, expires: expiresAt });
  }

  clearSession(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { ...this.base(), httpOnly: true });
  }

  /** Readable by the SPA (not httpOnly) so it can echo it in the X-CSRF-Token header. */
  issueCsrf(res: Response): string {
    const nonce = randomBytes(24).toString('base64url');
    const token = `${nonce}.${this.sign(nonce)}`;
    res.cookie(CSRF_COOKIE, token, { ...this.base(), httpOnly: false });
    return token;
  }

  isValidCsrf(cookieToken: string | undefined, headerToken: string | undefined): boolean {
    if (!cookieToken || !headerToken || cookieToken.length > 200) return false;
    if (!this.hashing.safeEqual(cookieToken, headerToken)) return false;
    const [nonce, sig] = cookieToken.split('.');
    return !!nonce && !!sig && this.hashing.safeEqual(sig, this.sign(nonce));
  }

  private sign(nonce: string): string {
    return createHmac('sha256', this.env.CSRF_SECRET).update(nonce).digest('base64url');
  }
}
