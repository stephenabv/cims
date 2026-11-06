import type { CurrentUser } from '@cims/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app/App';
import { AuthProvider } from '@/lib/auth';
import { mockFetch } from './fetch-mock';

const staff: CurrentUser = {
  id: 'u1',
  employeeId: 'e1',
  accountNumber: 'EMP-000123',
  fullName: 'Ana Santos',
  email: 'ana@acme.test',
  role: { key: 'STAFF', name: 'Staff' },
  permissions: [],
  mustChangePassword: false,
  mfaEnabled: false,
  mfaRequired: false,
};

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const unauthenticated = () => ({
  status: 401,
  body: { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } },
});
const csrf = () => ({ status: 200, body: { csrfToken: 'n.s' }, setCookie: 'cims_csrf=n.s' });

describe('sign-in flow', () => {
  beforeEach(() => {
    document.cookie = 'cims_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('redirects anonymous users from the app to the login page', async () => {
    mockFetch({ 'GET /auth/me': unauthenticated });
    renderAt('/app');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('validates the form before calling the API', async () => {
    const { calls } = mockFetch({ 'GET /auth/me': unauthenticated });
    renderAt('/login');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('Enter a valid employee number, e.g. 123 or EMP-000123'),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/auth/login')).toBe(false);
  });

  it('signs in, sends the CSRF header and lands on the home page', async () => {
    let authed = false;
    const { calls } = mockFetch({
      'GET /auth/me': () => (authed ? { status: 200, body: staff } : unauthenticated()),
      'GET /auth/csrf': csrf,
      'POST /auth/login': () => {
        authed = true;
        return { status: 200, body: { status: 'AUTHENTICATED', user: staff } };
      },
    });
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Employee number'), 'emp-000123');
    await userEvent.type(screen.getByLabelText('Password'), 'Valid-Password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening), Ana$/ }),
    ).toBeInTheDocument();
    const login = calls.find((c) => c.path === '/auth/login')!;
    expect(login.headers['X-CSRF-Token']).toBe('n.s');
    expect(login.body).toEqual({ accountNumber: 'EMP-000123', password: 'Valid-Password-123' });
  });

  it('shows the server error for bad credentials', async () => {
    mockFetch({
      'GET /auth/me': unauthenticated,
      'GET /auth/csrf': csrf,
      'POST /auth/login': () => ({
        status: 401,
        body: {
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid account number or password' },
        },
      }),
    });
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Employee number'), 'EMP-000123');
    await userEvent.type(screen.getByLabelText('Password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid account number or password',
    );
  });

  it('asks for a TOTP code when MFA is required', async () => {
    mockFetch({
      'GET /auth/me': unauthenticated,
      'GET /auth/csrf': csrf,
      'POST /auth/login': () => ({ status: 200, body: { status: 'MFA_REQUIRED' } }),
    });
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Employee number'), 'EMP-000123');
    await userEvent.type(screen.getByLabelText('Password'), 'Valid-Password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('heading', { name: 'Two-factor verification' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Verification code')).toBeInTheDocument();
  });

  it('forces a password change for temporary passwords', async () => {
    mockFetch({
      'GET /auth/me': () => ({ status: 200, body: { ...staff, mustChangePassword: true } }),
    });
    renderAt('/app');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument(),
    );
  });
});
