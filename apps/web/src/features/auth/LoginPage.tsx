import { type CurrentUser, type LoginInput, type LoginResult, loginSchema } from '@cims/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { api, errorMessage } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { AuthLayout } from './AuthLayout';
import { MfaEnrollment } from './MfaEnrollment';
import { MfaChallenge } from './MfaChallenge';

type Step = 'password' | 'mfa' | 'enroll';

export function LoginPage() {
  const [step, setStep] = useState<Step>('password');
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/app';

  const finish = (user: CurrentUser) => {
    setUser(user);
    navigate(user.mustChangePassword ? '/change-password' : from, { replace: true });
  };

  if (step === 'mfa') {
    return (
      <AuthLayout
        title="Two-factor verification"
        subtitle="Enter the 6-digit code from your authenticator app."
      >
        <MfaChallenge onSuccess={finish} onCancel={() => setStep('password')} />
      </AuthLayout>
    );
  }
  if (step === 'enroll') {
    return (
      <AuthLayout
        title="Set up two-factor authentication"
        subtitle="Your role requires a second sign-in step."
      >
        <MfaEnrollment onComplete={finish} />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Sign in" subtitle="Use your employee account number and password.">
      <PasswordStep
        onResult={(r) =>
          r.status === 'AUTHENTICATED'
            ? finish(r.user)
            : setStep(r.status === 'MFA_REQUIRED' ? 'mfa' : 'enroll')
        }
      />
    </AuthLayout>
  );
}

function PasswordStep({ onResult }: { onResult: (r: LoginResult) => void }) {
  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { accountNumber: '', password: '' },
  });
  const login = useMutation({
    mutationFn: (input: LoginInput) =>
      api<LoginResult>('/auth/login', { method: 'POST', body: input }),
    onSuccess: onResult,
  });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((v) => login.mutate(v))}
      className="flex flex-col gap-4"
    >
      {login.isError && <Alert tone="error">{errorMessage(login.error)}</Alert>}
      <TextField
        label="Account number"
        placeholder="EMP-000123"
        autoComplete="username"
        autoCapitalize="characters"
        error={form.formState.errors.accountNumber?.message}
        {...form.register('accountNumber')}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        error={form.formState.errors.password?.message}
        {...form.register('password')}
      />
      <Button type="submit" loading={login.isPending} fullWidth>
        Sign in
      </Button>
      <Link
        to="/forgot-password"
        className="text-center text-sm font-medium text-brand-700 hover:underline dark:text-brand-100"
      >
        Forgot your password?
      </Link>
    </form>
  );
}
