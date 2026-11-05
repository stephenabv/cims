import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { Clock } from '../../infrastructure/clock/clock';

const STEP_SECONDS = 30;

/** RFC 6238 TOTP with ±1 step tolerance and replay protection via the last accepted step. */
@Injectable()
export class TotpService {
  constructor(private readonly clock: Clock) {}

  generateSecret(): string {
    return authenticator.generateSecret(20);
  }

  keyUri(accountName: string, issuer: string, secret: string): string {
    return authenticator.keyuri(accountName, issuer, secret);
  }

  /** Returns the matched time-step, or null when the code is invalid or already used. */
  verify(secret: string, code: string, lastUsedStep: bigint | null): bigint | null {
    const epoch = this.clock.now().getTime();
    const instance = authenticator.clone({ epoch, step: STEP_SECONDS, window: 1 });
    const delta = instance.checkDelta(code, secret);
    if (delta === null) return null;
    const step = BigInt(Math.floor(epoch / 1000 / STEP_SECONDS) + delta);
    if (lastUsedStep !== null && step <= lastUsedStep) return null;
    return step;
  }

  /** Test helper and enrolment preview: the code valid right now. */
  currentCode(secret: string): string {
    return authenticator
      .clone({ epoch: this.clock.now().getTime(), step: STEP_SECONDS })
      .generate(secret);
  }
}
