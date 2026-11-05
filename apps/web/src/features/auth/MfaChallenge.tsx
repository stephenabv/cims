import { type CurrentUser, type MfaVerifyInput, mfaVerifySchema } from '@cims/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { api, errorMessage } from '@/lib/api-client';

export function MfaChallenge({
  onSuccess,
  onCancel,
}: {
  onSuccess: (user: CurrentUser) => void;
  onCancel: () => void;
}) {
  const form = useForm<MfaVerifyInput>({
    resolver: zodResolver(mfaVerifySchema),
    defaultValues: { code: '' },
  });
  const verify = useMutation({
    mutationFn: (input: MfaVerifyInput) =>
      api<CurrentUser>('/auth/mfa/verify', { method: 'POST', body: input }),
    onSuccess,
    onError: () => form.reset({ code: '' }),
  });
  const cancel = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSettled: onCancel,
  });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((v) => verify.mutate(v))}
      className="flex flex-col gap-4"
    >
      {verify.isError && <Alert tone="error">{errorMessage(verify.error)}</Alert>}
      <TextField
        label="Verification code"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        hint="Lost your device? Enter one of your recovery codes (XXXX-XXXX)."
        error={form.formState.errors.code?.message}
        {...form.register('code')}
      />
      <Button type="submit" loading={verify.isPending} fullWidth>
        Verify
      </Button>
      <Button variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending} fullWidth>
        Use a different account
      </Button>
    </form>
  );
}
