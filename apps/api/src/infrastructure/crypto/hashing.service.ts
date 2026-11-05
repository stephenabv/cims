import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** OWASP-recommended argon2id baseline (m=19 MiB, t=2, p=1). */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class HashingService {
  /** A valid hash of a random value, used to equalise timing when no account matches. */
  private dummyHash: Promise<string> | null = null;

  hashSecret(secret: string): Promise<string> {
    return argon2.hash(secret, ARGON2_OPTIONS);
  }

  async verifySecret(hash: string, secret: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, secret);
    } catch {
      return false;
    }
  }

  /** Performs a verification of equal cost to `verifySecret`, always returning false. */
  async verifyAgainstDummy(secret: string): Promise<false> {
    this.dummyHash ??= this.hashSecret(randomBytes(16).toString('hex'));
    await this.verifySecret(await this.dummyHash, secret);
    return false;
  }

  /** Fast deterministic digest for high-entropy tokens (session, reset, recovery codes). */
  sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
