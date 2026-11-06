import {
  type KioskIdentifyResult,
  type KioskPunchResult,
  type PunchType,
  kioskIdentifySchema,
  normalizeEmployeeNumber,
} from '@cims/shared';
import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { ApiError, NetworkError, errorMessage } from '@/lib/api-client';
import { formatTime, formatWorkDate, todayIn } from '@/lib/datetime';
import {
  type KioskStatus,
  kioskStatusKey,
  readCachedKioskStatus,
  useConfirmPunch,
  useIdentify,
  useKioskStatus,
} from './api';
import {
  clearDeviceToken,
  isValidDeviceToken,
  readDeviceToken,
  saveDeviceToken,
} from './device-token';
import { type OfflineKiosk, useOfflineKiosk } from './useOfflineKiosk';

/** How long a result stays on screen before the kiosk is ready for the next person. */
export const RESULT_MS = 6_000;
/** How long the confirmation screen waits (the server's token lasts 90 s). */
export const CONFIRM_MS = 30_000;

/**
 * Accepts "1", "000123", "EMP1" or "emp-000123" and returns the canonical "EMP-000123"; anything
 * malformed is returned trimmed so the server's validation message is shown.
 */
export function normaliseAccountNumber(raw: string): string {
  return normalizeEmployeeNumber(raw) ?? raw.trim();
}

/**
 * Attendance terminal (spec §3.1, attendance spec §1): the default landing page. No sign-in;
 * each press is authenticated by employee number + PIN, and the terminal by its registration
 * token. One button: the server decides whether it is a time in or a time out.
 */
export function KioskPage() {
  const [token, setToken] = useState<string | null>(() => readDeviceToken());
  const status = useKioskStatus(token);
  // A registered kiosk keeps working when the server is unreachable, using its last known settings.
  const [cached] = useState(() => readCachedKioskStatus());
  const offlineMode =
    !status.data && status.isError && status.error instanceof NetworkError && !!token && !!cached;
  const current: KioskStatus | undefined =
    status.data ??
    (offlineMode && cached ? { ...cached, serverTime: new Date().toISOString() } : undefined);
  const offline = useOfflineKiosk(token, !!status.data?.device);

  return (
    <div className="relative isolate flex min-h-full flex-col overflow-hidden bg-brand-950 text-white">
      {/* Decorative: a soft sunrise glow behind the clock. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 -z-10 size-[42rem] -translate-x-1/2 rounded-full bg-sun-400/20 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-20 bg-gradient-to-b from-brand-800 via-brand-900 to-brand-950"
      />

      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <img src="/icon.svg" alt="" className="size-9 shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold sm:text-lg">
              {current?.companyName ?? 'CIMS'}
            </p>
            <p className="truncate text-xs text-brand-200">
              {current?.device ? `Attendance kiosk · ${current.device.name}` : 'Attendance kiosk'}
            </p>
          </div>
        </div>
        <Link
          to="/login"
          className="shrink-0 rounded-full px-4 py-2 text-sm font-medium text-brand-100 ring-1 ring-white/25 transition-colors hover:bg-white/10"
        >
          Employee sign-in
        </Link>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 pb-10">
        {status.isPending && !current ? (
          <Spinner className="size-8" />
        ) : !current ? (
          <div className="w-full max-w-md">
            <Alert tone="error" title="The attendance service is unavailable">
              {status.error ? errorMessage(status.error) : ''} Retrying automatically.
            </Alert>
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" onClick={() => void status.refetch()}>
                Retry now
              </Button>
            </div>
          </div>
        ) : (
          <>
            <LiveClock status={current} />
            <SyncBanner offlineMode={offlineMode} offline={offline} />
            {current.acceptsPunches ? (
              <PunchPanel
                token={token}
                timezone={current.timezone}
                offline={offline}
                offlineMode={offlineMode}
              />
            ) : (
              <DeviceSetup
                hadToken={token !== null}
                onSave={(t) => {
                  saveDeviceToken(t);
                  setToken(t);
                }}
              />
            )}
          </>
        )}
      </main>

      {token && status.data?.device && offline.pending === 0 && (
        <footer className="px-4 pb-4 text-center">
          <ForgetDevice
            onForget={() => {
              clearDeviceToken();
              setToken(null);
            }}
          />
        </footer>
      )}
    </div>
  );
}

function LiveClock({ status }: { status: KioskStatus }) {
  // Show server time (corrected for this device's clock drift) in the company timezone.
  const offset = useRef(0);
  useEffect(() => {
    offset.current = new Date(status.serverTime).getTime() - Date.now();
  }, [status.serverTime]);
  const [now, setNow] = useState(() => new Date(status.serverTime));
  useEffect(() => {
    const t = setInterval(() => setNow(new Date(Date.now() + offset.current)), 1000);
    return () => clearInterval(t);
  }, []);
  const time = new Intl.DateTimeFormat('en-PH', {
    timeZone: status.timezone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(now);
  const date = new Intl.DateTimeFormat('en-PH', {
    timeZone: status.timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(now);
  return (
    <div className="text-center">
      <p className="text-5xl font-bold tracking-tight tabular-nums sm:text-7xl" aria-live="off">
        {time}
      </p>
      <p className="mt-2 text-brand-100">{date}</p>
    </div>
  );
}

type Screen =
  | { kind: 'entry' }
  | { kind: 'confirm'; offer: Extract<KioskIdentifyResult, { status: 'READY' }> }
  | { kind: 'confirmOffline'; accountNumber: string; pin: string }
  | { kind: 'done'; result: KioskPunchResult }
  | { kind: 'queued'; at: string }
  | { kind: 'notice'; info: Exclude<KioskIdentifyResult, { status: 'READY' }> };

const ACTION_LABEL: Record<PunchType, string> = { TIME_IN: 'Time in', TIME_OUT: 'Time out' };

function PunchPanel({
  token,
  timezone,
  offline,
  offlineMode,
}: {
  token: string | null;
  timezone: string;
  offline: OfflineKiosk;
  offlineMode: boolean;
}) {
  const identify = useIdentify(token);
  const confirm = useConfirmPunch(token);
  const [screen, setScreen] = useState<Screen>({ kind: 'entry' });
  const [queueing, setQueueing] = useState(false);
  const [queueError, setQueueError] = useState<string>();
  const [accountNumber, setAccountNumber] = useState('');
  const [pin, setPin] = useState('');
  const [errors, setErrors] = useState<{ accountNumber?: string; pin?: string }>({});
  const accountRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  // Guards against a second submission between the click and React re-rendering the button.
  const busy = useRef(false);

  function reset() {
    setScreen({ kind: 'entry' });
    setAccountNumber('');
    setPin('');
    setErrors({});
    setQueueError(undefined);
    identify.reset();
    confirm.reset();
    busy.current = false;
    setTimeout(() => accountRef.current?.focus(), 0);
  }

  async function queueOffline(input: { accountNumber: string; pin: string }) {
    setQueueing(true);
    try {
      const item = await offline.queue(input);
      setScreen({ kind: 'queued', at: item.queuedAt });
    } catch (err) {
      setScreen({ kind: 'entry' });
      setQueueError(
        err instanceof Error ? err.message : 'Could not save attendance on this device.',
      );
      setPin('');
    } finally {
      setQueueing(false);
      busy.current = false;
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    const parsed = kioskIdentifySchema.safeParse({ accountNumber, pin });
    if (!parsed.success) {
      const fe: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof typeof errors;
        fe[key] ??= issue.message;
      }
      setErrors(fe);
      (fe.accountNumber ? accountRef : pinRef).current?.focus();
      return;
    }
    setErrors({});
    setQueueError(undefined);
    busy.current = true;
    if (offlineMode) {
      busy.current = false;
      return setScreen({ kind: 'confirmOffline', ...parsed.data });
    }
    // Send anything queued first so the server sees punches in the order they happened.
    if (offline.pending > 0) await offline.flush();
    identify.mutate(parsed.data, {
      onSuccess: (r) =>
        setScreen(
          r.status === 'READY' ? { kind: 'confirm', offer: r } : { kind: 'notice', info: r },
        ),
      onError: (err) => {
        if (err instanceof NetworkError && offline.canQueue)
          return setScreen({ kind: 'confirmOffline', ...parsed.data });
        setPin('');
        pinRef.current?.focus();
      },
      onSettled: () => {
        busy.current = false;
      },
    });
  }

  function confirmOffer(offer: Extract<KioskIdentifyResult, { status: 'READY' }>) {
    if (busy.current) return;
    busy.current = true;
    confirm.mutate(offer.confirmationToken, {
      onSuccess: (result) => setScreen({ kind: 'done', result }),
      onSettled: () => {
        busy.current = false;
      },
    });
  }

  switch (screen.kind) {
    case 'confirm':
      return (
        <ConfirmCard
          title={`Hi, ${screen.offer.displayName}`}
          action={screen.offer.action}
          detail={
            screen.offer.action === 'TIME_OUT' && screen.offer.timeInAt
              ? `You timed in at ${formatTime(screen.offer.timeInAt, timezone)}${
                  screen.offer.workDate !== todayIn(timezone)
                    ? ` (shift of ${formatWorkDate(screen.offer.workDate)})`
                    : ''
                }.`
              : screen.offer.workDate !== todayIn(timezone)
                ? `For the shift of ${formatWorkDate(screen.offer.workDate)}.`
                : 'No time in yet for today’s shift.'
          }
          pending={confirm.isPending}
          error={confirm.isError ? confirm.error : null}
          onConfirm={() => confirmOffer(screen.offer)}
          onCancel={reset}
        />
      );
    case 'confirmOffline':
      return (
        <ConfirmCard
          title="Save attendance offline?"
          action={null}
          detail="The connection is down. Your press is saved securely on this kiosk; whether it is a time in or a time out, and your PIN, are checked when the connection returns."
          pending={queueing}
          error={null}
          onConfirm={() => {
            if (busy.current) return;
            busy.current = true;
            void queueOffline({ accountNumber: screen.accountNumber, pin: screen.pin });
          }}
          onCancel={reset}
        />
      );
    case 'done':
      return (
        <ResultCard tone="success" onDone={reset}>
          <p className="mt-4 text-2xl font-bold">{ACTION_LABEL[screen.result.type]} recorded</p>
          <p className="mt-2 text-lg">
            {screen.result.displayName} · {formatTime(screen.result.occurredAt, timezone)}
          </p>
        </ResultCard>
      );
    case 'queued':
      return (
        <ResultCard tone="success" onDone={reset}>
          <p className="mt-4 text-2xl font-bold">Attendance saved offline</p>
          <p className="mt-2 text-lg">{formatTime(screen.at, timezone)} · pending sync</p>
          <p className="mt-2 text-sm text-emerald-50">
            It will be checked and sent when the connection returns.
          </p>
        </ResultCard>
      );
    case 'notice':
      return (
        <ResultCard tone="info" onDone={reset}>
          {screen.info.status === 'COMPLETED' ? (
            <>
              <p className="mt-4 text-2xl font-bold">Attendance already completed</p>
              <p className="mt-2 text-lg">
                {screen.info.displayName} · in {formatTime(screen.info.timeInAt, timezone)}, out{' '}
                {formatTime(screen.info.timeOutAt, timezone)}
              </p>
              <p className="mt-2 text-sm text-brand-100">
                Nothing was recorded. If this is wrong, request a correction from your account.
              </p>
            </>
          ) : (
            <>
              <p className="mt-4 text-2xl font-bold">Already recorded</p>
              <p className="mt-2 text-lg">
                {screen.info.displayName} · {ACTION_LABEL[screen.info.type].toLowerCase()} at{' '}
                {formatTime(screen.info.occurredAt, timezone)}
              </p>
              <p className="mt-2 text-sm text-brand-100">Nothing new was recorded.</p>
            </>
          )}
        </ResultCard>
      );
    case 'entry':
      break;
  }

  const working = identify.isPending || queueing;
  return (
    <form
      noValidate
      onSubmit={(e) => void submit(e)}
      className="w-full max-w-md animate-pop rounded-3xl bg-white p-6 text-slate-900 shadow-[var(--shadow-lift)] sm:p-8 dark:bg-slate-900 dark:text-slate-100"
      aria-label="Record attendance"
    >
      <div className="grid gap-5">
        <TextField
          ref={accountRef}
          label="Employee number"
          placeholder="e.g. 123"
          autoComplete="off"
          autoCapitalize="characters"
          inputMode="text"
          spellCheck={false}
          autoFocus
          inputSize="lg"
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          error={errors.accountNumber}
          hint="Leading zeros and “EMP” are optional."
        />
        <TextField
          ref={pinRef}
          label="PIN"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          inputSize="lg"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          error={errors.pin}
        />
        {queueError ? (
          <Alert tone="error" title="Attendance not recorded">
            {queueError}
          </Alert>
        ) : (
          identify.isError &&
          !(identify.error instanceof NetworkError && offline.canQueue) && (
            <PunchError error={identify.error} />
          )
        )}
        <Button type="submit" variant="accent" size="xl" fullWidth loading={working}>
          {working ? 'Checking…' : 'Record attendance'}
        </Button>
        <p className="text-center text-xs text-slate-500 dark:text-slate-400">
          We’ll tell you whether this is your time in or time out before anything is saved.
        </p>
      </div>
    </form>
  );
}

function ConfirmCard({
  title,
  action,
  detail,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  action: PunchType | null;
  detail: string;
  pending: boolean;
  error: Error | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancel = useLatest(onCancel);
  useEffect(() => confirmRef.current?.focus(), []);
  // Nobody confirmed: go back so the next person does not inherit this screen.
  useEffect(() => {
    if (pending) return;
    const t = setTimeout(() => cancel.current(), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [pending, cancel]);
  const label = action ? `Confirm ${ACTION_LABEL[action].toLowerCase()}` : 'Save offline';
  return (
    <section
      aria-labelledby="kiosk-confirm-title"
      className="w-full max-w-md animate-pop rounded-3xl bg-white p-6 text-center text-slate-900 shadow-[var(--shadow-lift)] sm:p-8 dark:bg-slate-900 dark:text-slate-100"
    >
      <h2 id="kiosk-confirm-title" className="text-xl font-semibold">
        {title}
      </h2>
      {action && (
        <p
          className={clsx(
            'mx-auto mt-4 inline-flex items-center gap-2 rounded-full px-5 py-2 text-2xl font-bold',
            action === 'TIME_IN'
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
              : 'bg-sun-100 text-sun-700 dark:bg-sun-700/30 dark:text-sun-200',
          )}
        >
          <span aria-hidden="true">{action === 'TIME_IN' ? '→' : '←'}</span>
          {ACTION_LABEL[action]}
        </p>
      )}
      <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">{detail}</p>
      {error && (
        <div className="mt-4 text-left">
          <PunchError error={error} />
        </div>
      )}
      <div className="mt-6 grid gap-3">
        <Button
          ref={confirmRef}
          variant="accent"
          size="xl"
          fullWidth
          loading={pending}
          disabled={!!error && error instanceof ApiError}
          onClick={onConfirm}
        >
          {label}
        </Button>
        <Button variant="ghost" fullWidth onClick={onCancel} disabled={pending}>
          {error ? 'Start over' : 'Cancel'}
        </Button>
      </div>
      {!pending && !error && <Countdown ms={CONFIRM_MS} tone="brand" />}
    </section>
  );
}

function ResultCard({
  tone,
  children,
  onDone,
}: {
  tone: 'success' | 'info';
  children: ReactNode;
  onDone: () => void;
}) {
  const done = useLatest(onDone);
  useEffect(() => {
    const t = setTimeout(() => done.current(), RESULT_MS);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <div
      role="status"
      className={clsx(
        'w-full max-w-md animate-pop overflow-hidden rounded-3xl p-8 text-center shadow-[var(--shadow-lift)]',
        tone === 'success' ? 'bg-emerald-600' : 'bg-brand-700',
      )}
    >
      {tone === 'success' ? (
        <svg className="mx-auto size-14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M5 12.5l4.5 4.5L19 7.5"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg className="mx-auto size-14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 11v5M12 8h.01"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      )}
      {children}
      <Button variant="secondary" className="mt-6" onClick={onDone}>
        Done
      </Button>
      <Countdown ms={RESULT_MS} tone="light" />
    </div>
  );
}

/** A ref that always holds the latest value, so timers are not restarted by re-renders. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** A thin bar that empties over `ms`, so people can see the screen is about to reset. */
function Countdown({ ms, tone }: { ms: number; tone: 'brand' | 'light' }) {
  return (
    <div
      aria-hidden="true"
      className={clsx(
        'mt-6 h-1 overflow-hidden rounded-full',
        tone === 'light' ? 'bg-white/20' : 'bg-slate-200 dark:bg-slate-700',
      )}
    >
      <div
        className={clsx('h-full origin-left', tone === 'light' ? 'bg-white/70' : 'bg-brand-500')}
        style={{ animation: `cims-drain ${ms}ms linear forwards` }}
      />
    </div>
  );
}

function SyncBanner({ offlineMode, offline }: { offlineMode: boolean; offline: OfflineKiosk }) {
  if (!offlineMode && offline.pending === 0) return null;
  const waiting =
    offline.pending === 0
      ? ''
      : ` ${offline.pending} ${offline.pending === 1 ? 'punch is' : 'punches are'} waiting to be sent.`;
  return (
    <div
      role="status"
      className="w-full max-w-md rounded-2xl bg-sun-400/15 px-4 py-3 text-center text-sm text-sun-100 ring-1 ring-sun-300/30"
    >
      {offlineMode || !offline.reachable
        ? `Offline: punches are saved on this device and sent when the connection returns.${waiting}`
        : offline.syncing
          ? `Sending saved punches…${waiting}`
          : `Back online.${waiting} Retrying shortly.`}
    </div>
  );
}

function PunchError({ error }: { error: Error }) {
  const qc = useQueryClient();
  const deviceRejected =
    error instanceof ApiError && error.status === 401 && /device/i.test(error.message);
  useEffect(() => {
    // The device was revoked while the page was open: re-check status to show the setup screen.
    if (deviceRejected) void qc.invalidateQueries({ queryKey: kioskStatusKey(null).slice(0, 2) });
  }, [deviceRejected, qc]);
  const title =
    error instanceof ApiError && error.status === 409 ? 'Not recorded' : 'Attendance not recorded';
  return (
    <Alert tone="error" title={title}>
      {errorMessage(error)}
    </Alert>
  );
}

function DeviceSetup({ hadToken, onSave }: { hadToken: boolean; onSave: (t: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  return (
    <div className="w-full max-w-md rounded-3xl bg-white p-6 text-slate-900 shadow-[var(--shadow-lift)] sm:p-8 dark:bg-slate-900 dark:text-slate-100">
      <h1 className="text-lg font-semibold">
        {hadToken ? 'This kiosk registration is no longer valid' : 'Set up this attendance kiosk'}
      </h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        An IT administrator registers kiosks under Kiosk devices and receives a one-time device key.
        Enter it here, or open Kiosk devices on this browser and choose “Use this browser”.
      </p>
      <form
        noValidate
        className="mt-5 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!isValidDeviceToken(value)) {
            setError('Device keys start with kio_ and are about 45 characters long.');
            return;
          }
          onSave(value.trim());
        }}
      >
        <TextField
          label="Device key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={error}
        />
        <Button type="submit">Save device key</Button>
      </form>
    </div>
  );
}

function ForgetDevice({ onForget }: { onForget: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <button
        type="button"
        className="text-xs text-brand-200 underline-offset-2 hover:underline"
        onClick={() => setConfirming(true)}
      >
        Remove kiosk registration from this browser
      </button>
    );
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
      <span className="text-brand-100">Remove the device key from this browser?</span>
      <Button variant="danger" size="sm" onClick={onForget}>
        Remove
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-white hover:bg-white/10"
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
    </div>
  );
}
