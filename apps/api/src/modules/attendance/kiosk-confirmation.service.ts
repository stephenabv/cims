import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EncryptionService } from '../../infrastructure/crypto/encryption.service';

/** How long the "confirm time in / time out" screen may wait before the person must start over. */
export const CONFIRMATION_TTL_MS = 90_000;

const TOKEN_PREFIX = 'kc1.';

const claimsSchema = z.object({
  /** Purpose tag, so no other encrypted value can be replayed as a confirmation. */
  p: z.literal('kiosk-confirm'),
  employeeId: z.string().uuid(),
  userId: z.string().uuid(),
  /** Device that identified the employee; the confirmation must come from the same one. */
  deviceId: z.string().uuid().nullable(),
  action: z.enum(['TIME_IN', 'TIME_OUT']),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Idempotency key: stored as the punch's client_uuid, so a retried confirm records nothing new. */
  nonce: z.string().uuid(),
  exp: z.number().int(),
});
export type ConfirmationClaims = z.infer<typeof claimsSchema>;

/**
 * Short-lived, encrypted and authenticated (AES-256-GCM) proof that an employee passed the PIN
 * check on a given kiosk and was offered a specific action. The kiosk cannot read or alter it,
 * and it carries no credentials, so the PIN is not sent twice.
 */
@Injectable()
export class KioskConfirmationService {
  constructor(private readonly encryption: EncryptionService) {}

  issue(
    claims: Omit<ConfirmationClaims, 'p' | 'nonce' | 'exp'>,
    now: Date,
  ): { token: string; expiresAt: Date } {
    const exp = now.getTime() + CONFIRMATION_TTL_MS;
    const body: ConfirmationClaims = { p: 'kiosk-confirm', ...claims, nonce: randomUUID(), exp };
    return {
      token: TOKEN_PREFIX + this.encryption.encrypt(JSON.stringify(body)),
      expiresAt: new Date(exp),
    };
  }

  /** Claims of a genuine token, or null when it is forged, malformed or for another purpose. */
  read(token: string): ConfirmationClaims | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    try {
      const parsed = claimsSchema.safeParse(
        JSON.parse(this.encryption.decrypt(token.slice(TOKEN_PREFIX.length))),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
