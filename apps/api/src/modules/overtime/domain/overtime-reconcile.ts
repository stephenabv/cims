import type { OvertimeStatus } from '@cims/shared';

export interface ExistingOvertime {
  status: OvertimeStatus;
  actualMinutes: number;
  /** Whether any decision or system change has been recorded for it. */
  hasHistory: boolean;
}

/** What to do with a day's overtime record after its attendance was recomputed. */
export type OvertimeChange =
  | { kind: 'none' }
  | { kind: 'create'; actualMinutes: number }
  /** Still undecided: just track the new figure. */
  | { kind: 'update'; actualMinutes: number }
  /** A decision was based on figures that changed: it must be made again. */
  | { kind: 'reopen'; actualMinutes: number; previousMinutes: number }
  /** Undecided and no longer overtime: nothing worth keeping. */
  | { kind: 'delete' }
  /** No longer overtime, but its history must stay visible. */
  | { kind: 'void'; previousMinutes: number };

/**
 * Keeps an overtime record consistent with the attendance it came from.
 *
 * `overtimeMinutes` is null when the day has no completed attendance (no punches, or still
 * incomplete). Any change after a decision reopens the record: payroll must never pay minutes an
 * approver did not see.
 */
export function reconcileOvertime(
  existing: ExistingOvertime | null,
  overtimeMinutes: number | null,
  minimumMinutes: number,
): OvertimeChange {
  const qualifies =
    overtimeMinutes !== null && overtimeMinutes > 0 && overtimeMinutes >= minimumMinutes;

  if (!existing) {
    return qualifies ? { kind: 'create', actualMinutes: overtimeMinutes } : { kind: 'none' };
  }
  if (!qualifies) {
    if (existing.status === 'VOIDED') return { kind: 'none' };
    if (existing.status === 'PENDING' && !existing.hasHistory) return { kind: 'delete' };
    return { kind: 'void', previousMinutes: existing.actualMinutes };
  }
  if (existing.status === 'PENDING') {
    return overtimeMinutes === existing.actualMinutes
      ? { kind: 'none' }
      : { kind: 'update', actualMinutes: overtimeMinutes };
  }
  if (existing.status !== 'VOIDED' && overtimeMinutes === existing.actualMinutes) {
    return { kind: 'none' };
  }
  return {
    kind: 'reopen',
    actualMinutes: overtimeMinutes,
    previousMinutes: existing.actualMinutes,
  };
}
