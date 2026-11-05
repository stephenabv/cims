import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app/App';
import { normaliseAccountNumber } from '@/features/kiosk/KioskPage';
import { AuthProvider } from '@/lib/auth';
import { mockFetch } from './fetch-mock';

const TOKEN = `kio_${'a'.repeat(43)}`;
const status = (registered: boolean) => () => ({
  status: 200,
  body: {
    device: registered ? { name: 'Lobby tablet' } : null,
    acceptsPunches: registered,
    companyName: 'Acme Corp',
    timezone: 'Asia/Manila',
    serverTime: '2026-11-04T00:30:00.000Z',
  },
});
const unauthenticated = () => ({
  status: 401,
  body: { error: { code: 'UNAUTHENTICATED', message: 'x' } },
});

function renderKiosk() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/']}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('attendance kiosk', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('normalises typed account numbers', () => {
    expect(normaliseAccountNumber('123')).toBe('EMP-000123');
    expect(normaliseAccountNumber(' emp-000123 ')).toBe('EMP-000123');
    expect(normaliseAccountNumber('EMP000123')).toBe('EMP-000123');
  });

  it('asks for a device key on an unregistered device and validates it', async () => {
    mockFetch({ 'GET /auth/me': unauthenticated, 'GET /kiosk/status': status(false) });
    renderKiosk();
    expect(
      await screen.findByRole('heading', { name: 'Set up this attendance kiosk' }),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Device key'), 'not-a-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save device key' }));
    expect(screen.getByText(/Device keys start with kio_/)).toBeInTheDocument();
    expect(localStorage.getItem('cims.kioskDeviceToken')).toBeNull();
  });

  it('records a punch with the device token and shows a confirmation in company time', async () => {
    localStorage.setItem('cims.kioskDeviceToken', TOKEN);
    const { calls } = mockFetch({
      'GET /auth/me': unauthenticated,
      'GET /kiosk/status': status(true),
      'POST /kiosk/punch': () => ({
        status: 201,
        body: {
          type: 'TIME_IN',
          occurredAt: '2026-11-04T00:30:00.000Z',
          workDate: '2026-11-04',
          displayName: 'Ana S.',
        },
      }),
    });
    renderKiosk();
    await userEvent.type(await screen.findByLabelText('Account number'), '123');
    await userEvent.type(screen.getByLabelText('PIN'), '482915');
    await userEvent.click(screen.getByRole('button', { name: 'Time in' }));

    expect(await screen.findByText('Time in recorded')).toBeInTheDocument();
    expect(screen.getByText(/Ana S\. · 8:30/)).toBeInTheDocument();
    const punch = calls.find((c) => c.path === '/kiosk/punch')!;
    expect(punch.body).toEqual({ accountNumber: 'EMP-000123', pin: '482915', type: 'TIME_IN' });
    expect(punch.headers['X-Kiosk-Token']).toBe(TOKEN);
    expect(punch.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('shows the server reason and clears the PIN when a punch is rejected', async () => {
    localStorage.setItem('cims.kioskDeviceToken', TOKEN);
    mockFetch({
      'GET /auth/me': unauthenticated,
      'GET /kiosk/status': status(true),
      'POST /kiosk/punch': () => ({
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: 'You are already timed in since 8:05 AM. Time out first.',
            details: { reason: 'ALREADY_TIMED_IN' },
          },
        },
      }),
    });
    renderKiosk();
    await userEvent.type(await screen.findByLabelText('Account number'), 'EMP-000123');
    await userEvent.type(screen.getByLabelText('PIN'), '482915');
    await userEvent.click(screen.getByRole('button', { name: 'Time in' }));
    expect(await screen.findByText(/already timed in since 8:05 AM/)).toBeInTheDocument();
    expect(screen.getByLabelText('PIN')).toHaveValue('');
    expect(screen.getByLabelText('Account number')).toHaveValue('EMP-000123');
  });

  it('validates the PIN format before calling the API', async () => {
    localStorage.setItem('cims.kioskDeviceToken', TOKEN);
    const { calls } = mockFetch({
      'GET /auth/me': unauthenticated,
      'GET /kiosk/status': status(true),
    });
    renderKiosk();
    await userEvent.type(await screen.findByLabelText('Account number'), '123');
    await userEvent.type(screen.getByLabelText('PIN'), '12');
    await userEvent.click(screen.getByRole('button', { name: 'Time out' }));
    expect(screen.getByText('PIN must be 6 digits')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/kiosk/punch')).toBe(false);
  });
});
