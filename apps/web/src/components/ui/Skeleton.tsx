import { clsx } from 'clsx';

/** Placeholder block shown while content loads; hidden from assistive tech (pair with a status). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={clsx('skeleton', className ?? 'h-4 w-full')} />;
}

/** A list of card-shaped placeholders with an accessible loading status. */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="grid gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="rounded-[var(--radius-card)] bg-white p-5 shadow-[var(--shadow-card)] ring-1 ring-slate-200/70 dark:bg-slate-900 dark:ring-slate-800"
        >
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-3 h-3 w-2/3" />
          <Skeleton className="mt-2 h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
