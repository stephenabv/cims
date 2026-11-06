import type { CorrectionStatus, CorrectionType } from '@cims/shared';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const CORRECTION_TYPE: Record<CorrectionType, { label: string; help: string }> = {
  CHANGE_TIME_IN: {
    label: 'Change of time in',
    help: 'Your time in was recorded, but at the wrong time.',
  },
  CHANGE_TIME_OUT: {
    label: 'Change of time out',
    help: 'Your time out was recorded, but at the wrong time.',
  },
  MISSING_TIME_IN: { label: 'Missing time in', help: 'You worked but no time in was recorded.' },
  MISSING_TIME_OUT: { label: 'Missing time out', help: 'You forgot to time out, or it failed.' },
  INCORRECT_TIMESTAMP: {
    label: 'Incorrect timestamp',
    help: 'Any recorded punch has the wrong date or time.',
  },
  OTHER: {
    label: 'Other',
    help: 'Anything else about this record. HR applies it by hand after approval.',
  },
};

export const CORRECTION_STATUS: Record<CorrectionStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};
