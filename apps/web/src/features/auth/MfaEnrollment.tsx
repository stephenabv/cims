import { type CurrentUser, type MfaVerifyInput, mfaVerifySchema } from '@cims/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { api, errorMessage } from '@/lib/api-client';

interface EnrollStart {
  secret: string;
  otpauthUrl: string;
}

export function MfaEnrollment({ onComplete }: { onComplete: (user: CurrentUser) => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [result, setResult] = useState<{ recoveryCodes: string[]; user: CurrentUser } | null>(null);
  // Starting enrolment rotates the server-side secret, so it must run exactly once per visit.
  // A non-refetching query (rather than an effect + mutation) survives StrictMode remounts and
  // de-duplicates the in-flight request.
  const start = useQuery({
    queryKey: ['auth', 'mfa-enrollment'],
    queryFn: () => api<EnrollStart>('/auth/mfa/enroll', { method: 'POST' }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
  const form = useForm<MfaVerifyInput>({
    resolver: zodResolver(mfaVerifySchema),
    defaultValues: { code: '' },
  });
  const confirm = useMutation({
    mutationFn: (input: MfaVerifyInput) =>
      api<{ recoveryCodes: string[]; user: CurrentUser }>('/auth/mfa/enroll/confirm', {
        method: 'POST',
        body: input,
      }),
    onSuccess: setResult,
  });

  useEffect(() => {
    if (!start.data) return;
    let active = true;
    void QRCode.toDataURL(start.data.otpauthUrl, { margin: 1, width: 192 }).then(
      (url) => active && setQr(url),
    );
    return () => {
      active = false;
    };
  }, [start.data]);

  if (result) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success" title="Two-factor authentication is on">
          Save these recovery codes somewhere safe. Each code works once if you lose your device.
          They will not be shown again.
        </Alert>
        <ul
          className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-4 font-mono text-sm dark:bg-slate-800"
          aria-label="Recovery codes"
        >
          {result.recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Button onClick={() => onComplete(result.user)} fullWidth>
          I have saved my recovery codes
        </Button>
      </div>
    );
  }

  if (start.isError) return <Alert tone="error">{errorMessage(start.error)}</Alert>;
  if (!start.data) return <Spinner label="Preparing enrolment" />;

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((v) => confirm.mutate(v))}
      className="flex flex-col gap-4"
    >
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
        <li>
          Install an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…).
        </li>
        <li>Scan the QR code, or enter the setup key manually.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <div className="flex flex-col items-center gap-2">
        {qr ? (
          <img
            src={qr}
            alt="QR code for your authenticator app"
            className="size-48 rounded-lg bg-white p-2"
          />
        ) : (
          <Spinner />
        )}
        <code className="rounded bg-slate-100 px-2 py-1 text-xs break-all dark:bg-slate-800">
          {start.data.secret}
        </code>
      </div>
      {confirm.isError && <Alert tone="error">{errorMessage(confirm.error)}</Alert>}
      <TextField
        label="Verification code"
        inputMode="numeric"
        autoComplete="one-time-code"
        error={form.formState.errors.code?.message}
        {...form.register('code')}
      />
      <Button type="submit" loading={confirm.isPending} fullWidth>
        Turn on two-factor authentication
      </Button>
    </form>
  );
}
