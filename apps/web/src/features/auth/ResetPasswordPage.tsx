import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { api, errorMessage } from '@/lib/api-client';
import { AuthLayout } from './AuthLayout';
import { PASSWORD_HINT, type ResetPasswordForm, resetPasswordFormSchema } from './password-forms';

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const form = useForm<ResetPasswordForm>({
    resolver: zodResolver(resetPasswordFormSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });
  const reset = useMutation({
    mutationFn: ({ newPassword }: ResetPasswordForm) =>
      api('/auth/password-recovery/complete', { method: 'POST', body: { token, newPassword } }),
  });

  if (!token) {
    return (
      <AuthLayout title="Reset link missing">
        <Alert tone="error">This page needs the link from your reset email.</Alert>
        <Link
          to="/forgot-password"
          className="mt-4 inline-block text-sm font-medium text-brand-700 hover:underline"
        >
          Request a new link
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      {reset.isSuccess ? (
        <div className="flex flex-col gap-4">
          <Alert tone="success">
            Your password was changed. You have been signed out of all devices.
          </Alert>
          <Link
            to="/login"
            className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-100"
          >
            Sign in
          </Link>
        </div>
      ) : (
        <form
          noValidate
          onSubmit={form.handleSubmit((v) => reset.mutate(v))}
          className="flex flex-col gap-4"
        >
          {reset.isError && <Alert tone="error">{errorMessage(reset.error)}</Alert>}
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            hint={PASSWORD_HINT}
            error={form.formState.errors.newPassword?.message}
            {...form.register('newPassword')}
          />
          <TextField
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            error={form.formState.errors.confirmPassword?.message}
            {...form.register('confirmPassword')}
          />
          <Button type="submit" loading={reset.isPending} fullWidth>
            Set password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
