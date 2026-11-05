import { clsx } from 'clsx';
import type { ReactNode } from 'react';

type Tone = 'info' | 'success' | 'warning' | 'error';

const TONES: Record<Tone, string> = {
  info: 'bg-brand-50 text-brand-900 ring-brand-100 dark:bg-brand-900/30 dark:text-brand-100 dark:ring-brand-800',
  success:
    'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-100 dark:ring-emerald-800',
  warning:
    'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-100 dark:ring-amber-800',
  error:
    'bg-red-50 text-red-900 ring-red-200 dark:bg-red-900/30 dark:text-red-100 dark:ring-red-800',
};

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={clsx('rounded-lg px-4 py-3 text-sm ring-1 ring-inset', TONES[tone])}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={clsx(title && 'mt-1')}>{children}</div>}
    </div>
  );
}
