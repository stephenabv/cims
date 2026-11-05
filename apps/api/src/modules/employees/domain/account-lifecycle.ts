import type { AccountStatus } from '@prisma/client';
import type { LifecycleAction } from '@cims/shared';

/** Allowed account status transitions (§3.10). Anything else is an invalid transition. */
const TRANSITIONS: Record<LifecycleAction, { from: readonly AccountStatus[]; to: AccountStatus }> =
  {
    activate: { from: ['PENDING_ACTIVATION'], to: 'ACTIVE' },
    suspend: { from: ['ACTIVE'], to: 'SUSPENDED' },
    deactivate: { from: ['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED'], to: 'DEACTIVATED' },
    reactivate: { from: ['SUSPENDED', 'DEACTIVATED'], to: 'ACTIVE' },
  };

export function nextAccountStatus(
  current: AccountStatus,
  action: LifecycleAction,
): AccountStatus | null {
  const t = TRANSITIONS[action];
  return t.from.includes(current) ? t.to : null;
}

/** Statuses after which existing sessions must be terminated. */
export function revokesSessions(status: AccountStatus): boolean {
  return status === 'SUSPENDED' || status === 'DEACTIVATED';
}
