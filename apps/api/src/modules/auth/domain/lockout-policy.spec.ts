import { LockoutPolicy } from './lockout-policy';

describe('LockoutPolicy', () => {
  const policy = new LockoutPolicy({ maxAttempts: 3, lockoutMinutes: 15 });
  const now = new Date('2026-11-05T08:00:00Z');

  it('counts failures below the threshold without locking', () => {
    const s1 = policy.registerFailure({ failedCount: 0, lockedUntil: null }, now);
    expect(s1).toEqual({ failedCount: 1, lockedUntil: null, justLocked: false });
    const s2 = policy.registerFailure(s1, now);
    expect(s2.failedCount).toBe(2);
    expect(policy.isLocked(s2, now)).toBe(false);
  });

  it('locks on reaching the threshold and resets the counter', () => {
    const s = policy.registerFailure({ failedCount: 2, lockedUntil: null }, now);
    expect(s.justLocked).toBe(true);
    expect(s.failedCount).toBe(0);
    expect(s.lockedUntil).toEqual(new Date('2026-11-05T08:15:00Z'));
    expect(policy.isLocked(s, now)).toBe(true);
    expect(policy.isLocked(s, new Date('2026-11-05T08:15:00Z'))).toBe(false);
  });

  it('starts a fresh window after a lock expires', () => {
    const expired = { failedCount: 2, lockedUntil: new Date('2026-11-05T07:00:00Z') };
    expect(policy.registerFailure(expired, now)).toMatchObject({
      failedCount: 1,
      justLocked: false,
    });
  });

  it('clears state on success', () => {
    expect(policy.registerSuccess()).toEqual({ failedCount: 0, lockedUntil: null });
  });
});
