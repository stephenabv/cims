import type { OvertimeAction, OvertimeStatus } from '@cims/shared';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const OVERTIME_STATUS: Record<OvertimeStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  VOIDED: { label: 'No longer overtime', tone: 'neutral' },
};

export const OVERTIME_ACTION: Record<OvertimeAction, string> = {
  APPROVE: 'Approved',
  REJECT: 'Rejected',
  REOPEN: 'Reopened',
  VOID: 'Voided',
};
