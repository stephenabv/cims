import { type PasswordRecoveryRequestInput, passwordRecoveryRequestSchema } from '@cims/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { api, errorMessage } from '@/lib/api-client';
import { AuthLayout } from './AuthLayout';

export function ForgotPasswordPage() {
  const form = useForm<PasswordRecoveryRequestInput>({
    resolver: zodResolver(passwordRecoveryRequestSchema),
    defaultValues: { accountNumber: '' },
  });
  const request = useMutation({
    mutationFn: (input: PasswordRecoveryRequestInput) =>
      api<{ message: string }>('/auth/password-recovery', { method: 'POST', body: input }),
  });

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We will email a reset link to the company address registered to your account."
    >
      {request.isSuccess ? (
        <div className="flex flex-col gap-4">
          <Alert tone="success">{request.data.message}</Alert>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            No email? IT can issue a temporary password to your company email.
          </p>
          <Link
            to="/login"
            className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-100"
          >
            Back to sign in
          </Link>
        </div>
      ) : (
        <form
          noValidate
          onSubmit={form.handleSubmit((v) => request.mutate(v))}
          className="flex flex-col gap-4"
        >
          {request.isError && <Alert tone="error">{errorMessage(request.error)}</Alert>}
          <TextField
            label="Employee number"
            placeholder="e.g. 123 or EMP-000123"
            autoComplete="username"
            error={form.formState.errors.accountNumber?.message}
            {...form.register('accountNumber')}
          />
          <Button type="submit" loading={request.isPending} fullWidth>
            Send reset link
          </Button>
          <Link
            to="/login"
            className="text-center text-sm font-medium text-brand-700 hover:underline dark:text-brand-100"
          >
            Back to sign in
          </Link>
        </form>
      )}
    </AuthLayout>
  );
}
