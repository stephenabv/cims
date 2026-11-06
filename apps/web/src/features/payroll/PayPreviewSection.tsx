import { MAX_PAY_PERIOD_DAYS, type PayLine } from '@cims/shared';
import { clsx } from 'clsx';
import { useState } from 'react';
import { Loading } from '@/components/PageState';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { errorMessage } from '@/lib/api-client';
import { addDays, formatMinutes, formatWorkDate, todayIn } from '@/lib/datetime';
import { formatPeso } from '@/lib/money';
import { usePayPreview } from './api';
import { WARNING_TITLE } from './labels';
import { SectionHeader } from './parts';

/** The semi-monthly half (1–15 or 16–end of month) that contains the date. */
export function currentHalf(today: string): { from: string; to: string } {
  const month = today.slice(0, 7);
  if (Number(today.slice(8)) <= 15) return { from: `${month}-01`, to: `${month}-15` };
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { from: `${month}-16`, to: `${month}-${String(last).padStart(2, '0')}` };
}

function periodError(from: string, to: string): string | null {
  if (!from || !to) return 'Pick both dates';
  if (from > to) return 'End date must be on or after start';
  if (addDays(from, MAX_PAY_PERIOD_DAYS - 1) < to)
    return `A pay period covers at most ${MAX_PAY_PERIOD_DAYS} days`;
  return null;
}

/**
 * Calculates pay for any period from attendance, leave, overtime decisions and the pay setup, so
 * HR can check the terms before payroll is run. Nothing is saved; each calculation is audited, so
 * it only runs when asked.
 */
export function PayPreviewSection({
  employeeId,
  timezone,
}: {
  employeeId: string;
  timezone: string;
}) {
  const [range, setRange] = useState(() => currentHalf(todayIn(timezone)));
  const [submitted, setSubmitted] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = usePayPreview(
    employeeId,
    submitted?.from ?? '',
    submitted?.to ?? '',
    submitted !== null,
  );

  return (
    <section
      className="mt-6 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 sm:p-6 dark:bg-slate-900 dark:ring-slate-800"
      aria-labelledby="pay-preview"
    >
      <SectionHeader
        id="pay-preview"
        title="Pay calculation"
        description="Check what this employee would be paid for a period. Nothing is saved or released."
      />
      <form
        noValidate
        className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          const err = periodError(range.from, range.to);
          setError(err);
          if (!err) setSubmitted({ ...range });
        }}
      >
        <TextField
          label="From"
          type="date"
          value={range.from}
          onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
        />
        <TextField
          label="To"
          type="date"
          value={range.to}
          min={range.from || undefined}
          onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          error={error ?? undefined}
        />
        <Button type="submit" loading={preview.isFetching}>
          Calculate
        </Button>
      </form>

      {submitted &&
        (preview.isError ? (
          <div className="mt-4">
            <Alert tone="error">{errorMessage(preview.error)}</Alert>
          </div>
        ) : preview.isPending ? (
          <Loading />
        ) : (
          <div className="mt-4 grid gap-4">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {formatWorkDate(preview.data.from, { year: true })} –{' '}
              {formatWorkDate(preview.data.to, { year: true })}
            </p>
            {preview.data.warnings.length > 0 && (
              <Alert tone="warning" title="Check before paying">
                <ul className="list-disc space-y-1 pl-5">
                  {preview.data.warnings.map((w, i) => (
                    <li key={`${w.code}-${w.date ?? i}`}>
                      <span className="font-medium">{WARNING_TITLE[w.code]}</span>
                      {w.date && ` (${formatWorkDate(w.date)})`}: {w.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {preview.data.lines.length === 0 ? (
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Nothing to pay in this period.
              </p>
            ) : (
              <PayLines lines={preview.data.lines} />
            )}
            <dl className="grid gap-3 sm:grid-cols-3">
              {[
                { label: 'Gross pay', value: preview.data.grossCentavos },
                { label: 'Deductions', value: -preview.data.deductionsCentavos },
                { label: 'Net pay', value: preview.data.netCentavos, strong: true },
              ].map((t) => (
                <div key={t.label} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
                  <dt className="text-xs text-slate-500 dark:text-slate-400">{t.label}</dt>
                  <dd
                    className={clsx(
                      'mt-1 whitespace-nowrap tabular-nums',
                      t.strong ? 'text-lg font-bold' : 'font-semibold',
                      t.value < 0 && 'text-red-700 dark:text-red-400',
                    )}
                  >
                    {formatPeso(t.value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
    </section>
  );
}

function PayLines({ lines }: { lines: PayLine[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Pay breakdown</caption>
        <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400">
          <tr>
            <th scope="col" className="py-2 pr-3 font-medium">
              Item
            </th>
            <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">
              Time
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Amount
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {lines.map((l, i) => (
            <tr key={`${l.kind}-${l.label}-${i}`} className="align-top">
              <td className="py-2 pr-3">
                <span className="font-medium">{l.label}</span>
                <span className="block text-xs break-words text-slate-500 dark:text-slate-400">
                  {l.detail}
                </span>
              </td>
              <td className="hidden py-2 pr-3 tabular-nums sm:table-cell">
                {l.minutes === null ? '' : formatMinutes(l.minutes)}
              </td>
              <td
                className={clsx(
                  'py-2 text-right whitespace-nowrap tabular-nums',
                  l.amountCentavos < 0 && 'text-red-700 dark:text-red-400',
                )}
              >
                {formatPeso(l.amountCentavos)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
