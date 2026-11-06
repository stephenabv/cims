import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export function Card({
  title,
  description,
  children,
  className,
  actions,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  /** Optional controls shown at the right of the title. */
  actions?: ReactNode;
}) {
  return (
    <section
      className={clsx(
        'rounded-[var(--radius-card)] bg-white p-6 shadow-[var(--shadow-card)] ring-1 ring-slate-200/70 dark:bg-slate-900 dark:ring-slate-800',
        className,
      )}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && (
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{description}</p>
            )}
          </div>
          {actions}
        </div>
      )}
      {!title && description && (
        <p className="text-sm text-slate-600 dark:text-slate-400">{description}</p>
      )}
      <div className={clsx((title || description) && 'mt-5')}>{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: string;
  description?: string;
  /** Small label above the title, e.g. the module name. */
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-xs font-semibold tracking-wider text-sun-600 uppercase dark:text-sun-300">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}
