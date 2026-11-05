export interface LockoutConfig {
  maxAttempts: number;
  lockoutMinutes: number;
}

export interface LockoutState {
  failedCount: number;
  lockedUntil: Date | null;
}

/**
 * Pure lockout rule shared by password login and kiosk PIN verification (spec §5, BR-9).
 * After `maxAttempts` consecutive failures the credential is locked for `lockoutMinutes`;
 * the counter then restarts so each lock window allows a fresh set of attempts.
 */
export class LockoutPolicy {
  constructor(private readonly config: LockoutConfig) {}

  isLocked(state: LockoutState, now: Date): boolean {
    return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
  }

  registerFailure(state: LockoutState, now: Date): LockoutState & { justLocked: boolean } {
    // A lock that has already expired should not carry its counter into the new window.
    const base = state.lockedUntil && state.lockedUntil <= now ? 0 : state.failedCount;
    const failedCount = base + 1;
    if (failedCount >= this.config.maxAttempts) {
      return {
        failedCount: 0,
        lockedUntil: new Date(now.getTime() + this.config.lockoutMinutes * 60_000),
        justLocked: true,
      };
    }
    return { failedCount, lockedUntil: null, justLocked: false };
  }

  registerSuccess(): LockoutState {
    return { failedCount: 0, lockedUntil: null };
  }
}
