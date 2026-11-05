import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { ApiError, api, errorMessage } from '@/lib/api-client';
import { ME_QUERY_KEY, useAuth } from '@/lib/auth';
import { AuthLayout } from './AuthLayout';
import { type ChangePasswordForm, PASSWORD_HINT, changePasswordFormSchema } from './password-forms';

/** Used both for the forced change after a temporary password and for voluntary changes. */
export function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const form = useForm<ChangePasswordForm>({
    resolver: zodResolver(changePasswordFormSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });
  const change = useMutation({
    mutationFn: ({ currentPassword, newPassword }: ChangePasswordForm) =>
      api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),
    onSuccess: () => {
      form.reset();
      onDone();
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        for (const [path, message] of Object.entries(err.fieldErrors())) {
          if (path === 'currentPassword' || path === 'newPassword')
            form.setError(path, { message });
        }
      }
    },
  });
  const errors = form.formState.errors;
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((v) => change.mutate(v))}
      className="flex flex-col gap-4"
    >
      {change.isError &&
        !(change.error instanceof ApiError && change.error.code === 'VALIDATION_FAILED') && (
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
        label="New password"
        type="password"
        autoComplete="new-password"
        hint={PASSWORD_HINT}
        error={errors.newPassword?.message}
        {...form.register('newPassword')}
      />
      <TextField
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        error={errors.confirmPassword?.message}
        {...form.register('confirmPassword')}
      />
      <Button type="submit" loading={change.isPending}>
        Change password
      </Button>
    </form>
  );
}

export function ChangePasswordPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <AuthLayout
      title="Choose a new password"
      subtitle={
        user?.mustChangePassword
          ? 'You signed in with a temporary password. Set your own password to continue.'
          : undefined
      }
    >
      <ChangePasswordForm
        onDone={async () => {
          await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
          navigate('/app', { replace: true });
        }}
      />
    </AuthLayout>
  );
}
