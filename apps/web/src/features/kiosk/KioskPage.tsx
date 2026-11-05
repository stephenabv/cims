import { type KioskPunchResult, type PunchType, kioskPunchSchema } from '@cims/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import { formatTime } from '@/lib/datetime';
import { type KioskStatus, kioskStatusKey, useKioskStatus, usePunch } from './api';
import {
  clearDeviceToken,
  isValidDeviceToken,
  readDeviceToken,
  saveDeviceToken,
} from './device-token';

/** How long the confirmation stays on screen before the kiosk is ready for the next person. */
const CONFIRMATION_MS = 6_000;

/** Accepts "123", "000123" or "emp-000123" and returns the canonical "EMP-000123". */
export function normaliseAccountNumber(raw: string): string {
  const v = raw.trim().toUpperCase();
  if (/^\d{1,6}$/.test(v)) return `EMP-${v.padStart(6, '0')}`;
  if (/^EMP\d{6}$/.test(v)) return `EMP-${v.slice(3)}`;
  return v;
}

/**
 * Attendance terminal (spec §3.1): the default landing page. No sign-in; each punch is
 * authenticated by account number + PIN, and the terminal by its registration token.
 */
export function KioskPage() {
  const [token, setToken] = useState<string | null>(() => readDeviceToken());
  const status = useKioskStatus(token);

  return (
    <div className="flex min-h-full flex-col bg-gradient-to-b from-brand-900 to-slate-950 text-white">
      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-8">
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold">{status.data?.companyName ?? 'CIMS'}</p>
          <p className="truncate text-xs text-brand-100/80">
            {status.data?.device
              ? `Attendance kiosk · ${status.data.device.name}`
              : 'Attendance kiosk'}
          </p>
        </div>
        <Link
          to="/login"
          className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-brand-100 ring-1 ring-white/20 hover:bg-white/10"
        >
          Staff sign-in
        </Link>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 pb-10">
        {status.isPending ? (
          <Spinner className="size-8" />
        ) : status.isError ? (
          <div className="w-full max-w-md">
            <Alert tone="error" title="The attendance service is unavailable">
              {errorMessage(status.error)} Retrying automatically.
            </Alert>
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" onClick={() => void status.refetch()}>
                Retry now
              </Button>
            </div>
          </div>
        ) : (
          <>
            <LiveClock status={status.data} />
            {status.data.acceptsPunches ? (
              <PunchPanel token={token} timezone={status.data.timezone} />
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

      {token && status.data?.device && (
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
      <p className="text-5xl font-bold tabular-nums sm:text-7xl" aria-live="off">
        {time}
      </p>
      <p className="mt-2 text-brand-100/90">{date}</p>
    </div>
  );
}

function PunchPanel({ token, timezone }: { token: string | null; timezone: string }) {
  const punch = usePunch(token);
  const [accountNumber, setAccountNumber] = useState('');
  const [pin, setPin] = useState('');
  const [errors, setErrors] = useState<{ accountNumber?: string; pin?: string }>({});
  const [result, setResult] = useState<KioskPunchResult | null>(null);
  const accountRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  function reset() {
    setResult(null);
    setAccountNumber('');
    setPin('');
    setErrors({});
    punch.reset();
    setTimeout(() => accountRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!result) return;
    const t = setTimeout(reset, CONFIRMATION_MS);
    return () => clearTimeout(t);
    // reset only depends on stable setters
  }, [result]);

  function submit(type: PunchType) {
    const parsed = kioskPunchSchema.safeParse({
      accountNumber: normaliseAccountNumber(accountNumber),
      pin,
      type,
    });
    if (!parsed.success) {
      const fe: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof typeof errors;
        fe[key] ??= issue.message;
      }
      setErrors(fe);
      return;
    }
    setErrors({});
    punch.mutate(parsed.data, {
      onSuccess: (r) => setResult(r),
      onError: () => {
        setPin('');
        pinRef.current?.focus();
      },
    });
  }

  if (result) {
    return (
      <div
        role="status"
        className="w-full max-w-md rounded-2xl bg-emerald-600 p-8 text-center shadow-xl"
      >
        <svg className="mx-auto size-14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M5 12.5l4.5 4.5L19 7.5"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <p className="mt-4 text-2xl font-bold">
          {result.type === 'TIME_IN' ? 'Time in recorded' : 'Time out recorded'}
        </p>
        <p className="mt-2 text-lg">
          {result.displayName} · {formatTime(result.occurredAt, timezone)}
        </p>
        <Button variant="secondary" className="mt-6" onClick={reset}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e: FormEvent) => e.preventDefault()}
      className="w-full max-w-md rounded-2xl bg-white p-6 text-slate-900 shadow-xl sm:p-8 dark:bg-slate-900 dark:text-slate-100"
      aria-label="Record attendance"
    >
      <div className="grid gap-4">
        <TextField
          ref={accountRef}
          label="Account number"
          placeholder="EMP-000123"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          error={errors.accountNumber}
          hint="You can type just the digits."
        />
        <TextField
          ref={pinRef}
          label="PIN"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          error={errors.pin}
        />
        {punch.isError && <PunchError error={punch.error} />}
        <div className="grid grid-cols-2 gap-3 pt-2">
          <Button
            type="submit"
            className="min-h-14 text-base"
            loading={punch.isPending && punch.variables?.type === 'TIME_IN'}
            disabled={punch.isPending}
            onClick={() => submit('TIME_IN')}
          >
            Time in
          </Button>
          <Button
            variant="secondary"
            className="min-h-14 text-base"
            loading={punch.isPending && punch.variables?.type === 'TIME_OUT'}
            disabled={punch.isPending}
            onClick={() => submit('TIME_OUT')}
          >
            Time out
          </Button>
        </div>
      </div>
    </form>
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
    <div className="w-full max-w-md rounded-2xl bg-white p-6 text-slate-900 shadow-xl sm:p-8 dark:bg-slate-900 dark:text-slate-100">
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
        className="text-xs text-brand-100/70 underline-offset-2 hover:underline"
        onClick={() => setConfirming(true)}
      >
        Remove kiosk registration from this browser
      </button>
    );
  return (
    <div className="flex items-center justify-center gap-2 text-xs">
      <span className="text-brand-100/90">Remove the device key from this browser?</span>
      <Button variant="danger" className="min-h-8 px-3 text-xs" onClick={onForget}>
        Remove
      </Button>
      <Button
        variant="ghost"
        className="min-h-8 px-3 text-xs text-white hover:bg-white/10"
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
    </div>
  );
}
