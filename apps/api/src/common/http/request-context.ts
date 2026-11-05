import type { Request } from 'express';
import type { PermissionCode } from '@cims/shared';

/** Authenticated principal attached to the request by SessionGuard. */
export interface AuthContext {
  sessionId: string;
  userId: string;
  employeeId: string;
  accountNumber: string;
  roleKey: string;
  permissions: ReadonlySet<PermissionCode>;
  mfaVerified: boolean;
  mustChangePassword: boolean;
}

export interface CimsRequest extends Request {
  auth?: AuthContext;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function clientInfo(req: Request): ClientInfo {
  const ua = req.headers['user-agent'];
  const reqId: unknown = (req as { id?: unknown }).id;
  return {
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
    requestId: reqId === undefined ? null : String(reqId),
  };
}
