import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * Sign-in and account recovery screens: a brand panel (wide screens only) beside the form, so
 * the form is the first thing on a phone.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative isolate hidden overflow-hidden bg-brand-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div
          aria-hidden="true"
          className="absolute -top-32 -right-32 -z-10 size-[28rem] rounded-full bg-sun-400/25 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-20 bg-gradient-to-br from-brand-800 via-brand-900 to-brand-950"
        />
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="size-10" />
          <span className="text-lg font-bold tracking-tight">CIMS</span>
        </div>
        <div className="max-w-md">
          <p className="text-xs font-semibold tracking-wider text-sun-300 uppercase">
            Company Information Management System
          </p>
          <p className="mt-3 text-4xl leading-tight font-bold tracking-tight text-white">
            Your workday, in one clear place.
          </p>
          <p className="mt-4 text-brand-100">
            Attendance, leave, corrections and pay information for every employee, with approvals
            that leave a clear record.
          </p>
        </div>
        <Link
          to="/"
          className="w-fit rounded-full px-4 py-2 text-sm font-medium text-brand-100 ring-1 ring-white/25 hover:bg-white/10"
        >
          ← Attendance kiosk
        </Link>
      </aside>

      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <img src="/icon.svg" alt="" className="size-10" />
            <div>
              <p className="text-xs font-semibold tracking-wider text-brand-700 uppercase dark:text-brand-200">
                CIMS
              </p>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Company Information Management System
              </p>
            </div>
          </div>
          <div className="rounded-3xl bg-white p-6 shadow-[var(--shadow-card)] ring-1 ring-slate-200/70 sm:p-8 dark:bg-slate-900 dark:ring-slate-800">
            <h1 className="text-2xl font-bold">{title}</h1>
            {subtitle && (
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>
            )}
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </main>
    </div>
  );
}
