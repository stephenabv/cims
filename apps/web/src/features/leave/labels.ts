import type { ApprovalStepKind, LeaveStatus, LeaveStepStatus } from '@cims/shared';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const LEAVE_STATUS: Record<LeaveStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
};

export const STEP_KIND: Record<ApprovalStepKind, string> = {
  SUPERVISOR: 'Immediate supervisor',
  DEPARTMENT_HEAD: 'Department head',
  ROLE: 'Anyone with a role',
  EMPLOYEE: 'A specific person',
};

export const STEP_STATUS: Record<LeaveStepStatus, { label: string; tone: Tone }> = {
  WAITING: { label: 'Waiting', tone: 'neutral' },
  PENDING: { label: 'Awaiting decision', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  SKIPPED: { label: 'Skipped', tone: 'neutral' },
  CANCELLED: { label: 'Not needed', tone: 'neutral' },
};
