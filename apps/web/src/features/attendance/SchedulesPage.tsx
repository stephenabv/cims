import { type ScheduleInput, scheduleSchema } from '@cims/shared';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import { formatWorkDate, minuteToTime, timeToMinute } from '@/lib/datetime';
import { useEmployees } from '../employees/api';
import {
  type WorkSchedule,
  useAssignSchedule,
  useHolidayMutations,
  useHolidays,
  useSaveSchedule,
  useSchedules,
} from './api';
import { WEEKDAYS } from './labels';

export function SchedulesPage() {
  const schedules = useSchedules();
  const [editing, setEditing] = useState<WorkSchedule | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title="Schedules & holidays"
        description="Work schedules decide lateness, undertime and overtime. Employees without a schedule follow the company default."
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="grid content-start gap-6">
          <Card title="Work schedules">
            {schedules.isError ? (
              <Alert tone="error">{errorMessage(schedules.error)}</Alert>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {(schedules.data ?? []).map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">
                        {s.name} {s.isDefault && <Badge tone="info">Company default</Badge>}
                      </p>
                      <p className="text-xs text-slate-500">{describeDays(s)}</p>
                      <p className="text-xs text-slate-500">
                        Grace {s.graceMinutes} min · break {s.breakMinutes} min after{' '}
                        {s.breakThresholdMinutes / 60}h worked
                        {s.isDefault ? '' : ` · ${s._count.employees} assigned`}
                      </p>
                    </div>
                    <Button variant="ghost" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4">
              <Button variant="secondary" onClick={() => setEditing('new')}>
                New schedule
              </Button>
            </div>
          </Card>
          {editing && (
            <ScheduleEditor
              key={editing === 'new' ? 'new' : editing.id}
              schedule={editing === 'new' ? null : editing}
              onDone={() => setEditing(null)}
            />
          )}
          <AssignScheduleCard schedules={schedules.data ?? []} />
        </div>
        <HolidaysCard />
      </div>
    </>
  );
}

function describeDays(s: WorkSchedule): string {
  if (s.days.length === 0) return 'No working days';
  return s.days
    .map(
      (d) =>
        `${WEEKDAYS[d.weekday - 1]!.short} ${minuteToTime(d.startMinute)}–${minuteToTime(d.endMinute)}${d.endMinute > 1440 ? ' (+1)' : ''}`,
    )
    .join(', ');
}

interface DayRow {
  enabled: boolean;
  start: string;
  end: string;
}

function ScheduleEditor({
  schedule,
  onDone,
}: {
  schedule: WorkSchedule | null;
  onDone: () => void;
}) {
  const save = useSaveSchedule();
  const [name, setName] = useState(schedule?.name ?? '');
  const [grace, setGrace] = useState(String(schedule?.graceMinutes ?? 15));
  const [breakMin, setBreakMin] = useState(String(schedule?.breakMinutes ?? 60));
  const [threshold, setThreshold] = useState(String((schedule?.breakThresholdMinutes ?? 240) / 60));
  const [days, setDays] = useState<DayRow[]>(() =>
    WEEKDAYS.map((w) => {
      const d = schedule?.days.find((x) => x.weekday === w.value);
      return d
        ? { enabled: true, start: minuteToTime(d.startMinute), end: minuteToTime(d.endMinute) }
        : { enabled: !schedule && w.value <= 5, start: '08:00', end: '17:00' };
    }),
  );
  const [error, setError] = useState<string>();

  function submit() {
    const rows: ScheduleInput['days'] = [];
    for (const [i, d] of days.entries()) {
      if (!d.enabled) continue;
      const start = timeToMinute(d.start);
      let end = timeToMinute(d.end);
      if (start === null || end === null)
        return setError(`Enter start and end times for ${WEEKDAYS[i]!.label}.`);
      // An end time at or before the start means the shift ends the next day.
      if (end <= start) end += 1440;
      rows.push({ weekday: i + 1, startMinute: start, endMinute: end });
    }
    const parsed = scheduleSchema.safeParse({
      name,
      graceMinutes: Number(grace),
      breakMinutes: Number(breakMin),
      breakThresholdMinutes: Math.round(Number(threshold) * 60),
      days: rows,
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the schedule.');
    setError(undefined);
    save.mutate(
      { id: schedule?.id, body: parsed.data },
      {
        onSuccess: onDone,
        onError: (e) => setError(e instanceof ApiError ? e.message : errorMessage(e)),
      },
    );
  }

  return (
    <Card
      title={schedule ? `Edit ${schedule.name}` : 'New schedule'}
      description="Changes apply to attendance recorded from now on; days already computed keep their figures."
    >
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-3 gap-3">
          <TextField
            label="Grace (min)"
            type="number"
            min={0}
            max={240}
            value={grace}
            onChange={(e) => setGrace(e.target.value)}
          />
          <TextField
            label="Break (min)"
            type="number"
            min={0}
            max={240}
            value={breakMin}
            onChange={(e) => setBreakMin(e.target.value)}
          />
          <TextField
            label="Break after (h)"
            type="number"
            min={0}
            max={24}
            step={0.5}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </div>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">
            Working days
          </legend>
          {WEEKDAYS.map((w, i) => {
            const d = days[i]!;
            const set = (patch: Partial<DayRow>) =>
              setDays((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div
                key={w.value}
                className="grid grid-cols-[6.5rem_1fr_1fr] items-center gap-2 text-sm"
              >
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={d.enabled}
                    onChange={(e) => set({ enabled: e.target.checked })}
                  />
                  {w.label}
                </label>
                <input
                  type="time"
                  aria-label={`${w.label} start`}
                  disabled={!d.enabled}
                  value={d.start}
                  onChange={(e) => set({ start: e.target.value })}
                  className="min-h-10 rounded-lg border border-slate-300 bg-white px-2 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
                />
                <input
                  type="time"
                  aria-label={`${w.label} end`}
                  disabled={!d.enabled}
                  value={d.end}
                  onChange={(e) => set({ end: e.target.value })}
                  className="min-h-10 rounded-lg border border-slate-300 bg-white px-2 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
                />
              </div>
            );
          })}
          <p className="text-xs text-slate-500">
            An end time earlier than the start is treated as the next day (night shift).
          </p>
        </fieldset>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>
            Save schedule
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function AssignScheduleCard({ schedules }: { schedules: WorkSchedule[] }) {
  const employees = useEmployees({ page: 1, pageSize: 100, accountStatus: 'ACTIVE' });
  const assign = useAssignSchedule();
  const [employeeId, setEmployeeId] = useState('');
  const [scheduleId, setScheduleId] = useState('');
  const [done, setDone] = useState(false);
  const options = schedules.filter((s) => !s.isDefault && s.isActive);
  return (
    <Card
      title="Assign a schedule"
      description="Choose “Company default” to remove an employee's own schedule."
    >
      <form
        noValidate
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!employeeId) return;
          setDone(false);
          assign.mutate(
            { employeeId, scheduleId: scheduleId || null },
            { onSuccess: () => setDone(true) },
          );
        }}
      >
        <SelectField
          label="Employee"
          placeholder="Select an employee"
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          options={(employees.data?.data ?? []).map((e) => ({
            value: e.id,
            label: `${e.fullName} (${e.accountNumber})`,
          }))}
        />
        <SelectField
          label="Schedule"
          placeholder="Company default"
          value={scheduleId}
          onChange={(e) => setScheduleId(e.target.value)}
          options={options.map((s) => ({ value: s.id, label: s.name }))}
        />
        <div className="sm:col-span-2">
          <Button type="submit" disabled={!employeeId} loading={assign.isPending}>
            Assign
          </Button>
        </div>
      </form>
      {assign.isError && (
        <div className="mt-3">
          <Alert tone="error">{errorMessage(assign.error)}</Alert>
        </div>
      )}
      {done && (
        <div className="mt-3">
          <Alert tone="success">
            Schedule updated. The change is recorded in the employee's history.
          </Alert>
        </div>
      )}
    </Card>
  );
}

function HolidaysCard() {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const holidays = useHolidays(year);
  const { add, remove } = useHolidayMutations();
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  return (
    <Card
      title="Holidays"
      description="Days off for everyone. Work on a holiday is counted separately."
    >
      <div className="mb-4 flex items-center gap-2">
        <Button
          variant="secondary"
          aria-label="Previous year"
          onClick={() => setYear((y) => y - 1)}
        >
          ‹
        </Button>
        <span className="min-w-16 text-center font-semibold tabular-nums">{year}</span>
        <Button variant="secondary" aria-label="Next year" onClick={() => setYear((y) => y + 1)}>
          ›
        </Button>
      </div>
      <form
        noValidate
        className="grid gap-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (!date || name.trim().length < 2) return setError('Enter a date and a name.');
          setError(undefined);
          add.mutate(
            { date, name: name.trim() },
            {
              onSuccess: () => {
                setName('');
                setDate('');
                setYear(Number(date.slice(0, 4)));
              },
              onError: (err) => setError(errorMessage(err)),
            },
          );
        }}
      >
        <TextField
          label="Date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <TextField
          label="Name"
          placeholder="Independence Day"
          value={name}
          maxLength={150}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" loading={add.isPending}>
          Add
        </Button>
      </form>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      <div className="mt-4">
        {holidays.isError ? (
          <Alert tone="error">{errorMessage(holidays.error)}</Alert>
        ) : holidays.data?.length === 0 ? (
          <EmptyState title={`No holidays in ${year}`} />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {(holidays.data ?? []).map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="inline-block w-28 tabular-nums text-slate-500">
                    {formatWorkDate(h.date.slice(0, 10))}
                  </span>
                  {h.name}
                </span>
                <Button
                  variant="ghost"
                  aria-label={`Remove ${h.name}`}
                  loading={remove.isPending && remove.variables === h.id}
                  onClick={() => remove.mutate(h.id)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
