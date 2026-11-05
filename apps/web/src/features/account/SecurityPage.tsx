import { PASSWORD_MAX_LENGTH, pinSchema } from '@cims/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { TextField } from '@/components/ui/TextField';
import { ApiError, api, errorMessage } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { ChangePasswordForm } from '../auth/ChangePasswordPage';

const changePinFormSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
    newPin: pinSchema,
    confirmPin: z.string(),
  })
  .refine((v) => v.newPin === v.confirmPin, { message: 'PINs do not match', path: ['confirmPin'] });
type ChangePinForm = z.infer<typeof changePinFormSchema>;

function ChangePinCard() {
  const form = useForm<ChangePinForm>({
    resolver: zodResolver(changePinFormSchema),
    defaultValues: { currentPassword: '', newPin: '', confirmPin: '' },
  });
  const change = useMutation({
    mutationFn: ({ currentPassword, newPin }: ChangePinForm) =>
      api('/auth/pin', { method: 'POST', body: { currentPassword, newPin } }),
    onSuccess: () => form.reset(),
    onError: (err) => {
      if (err instanceof ApiError && err.fieldErrors().currentPassword)
        form.setError('currentPassword', { message: err.fieldErrors().currentPassword });
    },
  });
  const errors = form.formState.errors;
  return (
    <Card
      title="Attendance PIN"
      description="The 6-digit PIN you use at the attendance kiosk. Avoid repeated or sequential digits."
    >
      <form
        noValidate
        onSubmit={form.handleSubmit((v) => change.mutate(v))}
        className="flex max-w-sm flex-col gap-4"
      >
        {change.isSuccess && <Alert tone="success">Your PIN was changed.</Alert>}
        {change.isError && !form.formState.errors.currentPassword && (
          <Alert tone="error">{errorMessage(change.error)}</Alert>
        )}
        <TextField
          label="Current password"
          type="password"
          autoComplete="current-password"
          error={errors.currentPassword?.message}
          {...form.register('currentPassword')}
        />
        <TextField
          label="New PIN"
          type="password"
          inputMode="numeric"
          maxLength={6}
          autoComplete="off"
          error={errors.newPin?.message}
          {...form.register('newPin')}
        />
        <TextField
          label="Confirm new PIN"
          type="password"
          inputMode="numeric"
          maxLength={6}
          autoComplete="off"
          error={errors.confirmPin?.message}
          {...form.register('confirmPin')}
        />
        <Button type="submit" loading={change.isPending} className="self-start">
          Change PIN
        </Button>
      </form>
    </Card>
  );
}

export function SecurityPage() {
  const { user } = useAuth();
  const [passwordChanged, setPasswordChanged] = useState(false);
  return (
    <>
      <PageHeader
        title="Sign-in & security"
        description="Manage your password, attendance PIN and two-factor authentication."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Password"
          description="Changing your password signs you out of your other devices."
        >
          <div className="max-w-sm">
            {passwordChanged && (
              <div className="mb-4">
                <Alert tone="success">Your password was changed.</Alert>
              </div>
            )}
            <ChangePasswordForm onDone={() => setPasswordChanged(true)} />
          </div>
        </Card>
        <ChangePinCard />
        <Card title="Two-factor authentication">
          <p className="text-sm">
            Status:{' '}
            <span
              className={
                user?.mfaEnabled
                  ? 'font-semibold text-emerald-700 dark:text-emerald-400'
                  : 'font-semibold text-slate-600'
              }
            >
              {user?.mfaEnabled ? 'On' : 'Off'}
            </span>
            {user?.mfaRequired && ' · required for your role'}
          </p>
          {!user?.mfaEnabled && (
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Two-factor authentication is set up during sign-in for roles that require it.
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
