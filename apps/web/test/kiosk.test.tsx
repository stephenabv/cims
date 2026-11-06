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

  it('normalises typed employee numbers', () => {
    expect(normaliseAccountNumber('123')).toBe('EMP-000123');
    expect(normaliseAccountNumber(' emp-000123 ')).toBe('EMP-000123');
    expect(normaliseAccountNumber('EMP000123')).toBe('EMP-000123');
    expect(normaliseAccountNumber('EMP1')).toBe('EMP-000001');
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

  const ready = (action: 'TIME_IN' | 'TIME_OUT') => () => ({
    status: 200,
    body: {
      status: 'READY',
      displayName: 'Ana S.',
      action,
      workDate: '2026-11-04',
      timeInAt: action === 'TIME_OUT' ? '2026-11-04T00:05:00.000Z' : null,
      confirmationToken: 'kc1.token-token-token-token',
      expiresAt: '2026-11-04T00:32:00.000Z',
    },
  });
  const recorded = (type: 'TIME_IN' | 'TIME_OUT') => () => ({
    status: 201,
    body: {
      type,
      occurredAt: '2026-11-04T00:30:00.000Z',
      workDate: '2026-11-04',
      displayName: 'Ana S.',
    },
  });
  async function enter(number: string, pin = '482915') {
    await userEvent.type(await screen.findByLabelText('Employee number'), number);
    await userEvent.type(screen.getByLabelText('PIN'), pin);
    await userEvent.click(screen.getByRole('button', { name: 'Record attendance' }));
  }

  it('shows one button, asks the server what it will record, and confirms', async () => {
    localStorage.setItem('cims.kioskDeviceToken', TOKEN);
    const { calls } = mockFetch({
      'GET /auth/me': unauthenticated,
      'GET /kiosk/status': status(true),
      'POST /kiosk/identify': ready('TIME_IN'),
      'POST /kiosk/confirm': recorded('TIME_IN'),
    });
    renderKiosk();
    expect(await screen.findByRole('button', { name: 'Record attendance' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Time in' })).not.toBeInTheDocument();
    await enter('emp1');

    expect(await screen.findByText('Hi, Ana S.')).toBeInTheDocument();
    expect(screen.getByText('Time in')).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: 'Confirm time in' });
    // A double click records once: the second click lands while the first is in flight.
    await userEvent.dblClick(confirmButton);

    expect(await screen.findByText('Time in recorded')).toBeInTheDocument();
    expect(screen.getByText(/Ana S\. · 8:30/)).toBeInTheDocument();
    const identify = calls.find((c) => c.path === '/kiosk/identify')!;
    expect(identify.body).toEqual({ accountNumber: 'EMP-000001', pin: '482915' });
    expect(identify.headers['X-Kiosk-Token']).toBe(TOKEN);
    expect(identify.headers['X-CSRF-Token']).toBeUndefined();
    const confirms = calls.filter((c) => c.path === '/kiosk/confirm');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.body).toEqual({ confirmationToken: 'kc1.token-token-token-token' });
  });

  it('offers a time out when the server says the shift is open', async () => {
    localStorage.setItem('cims.kioskDeviceToken', TOKEN);
    mockFetch({
      'GET /auth/me': unauthenticated,
      'GET /kiosk/status': status(true),
      'POST /kiosk/identify': ready('TIME_OUT'),
      'POST /kiosk/confirm': recorded('TIME_OUT'),
    });
    renderKiosk();
    await enter('123');
    expect(await screen.findByText(/You timed in at 8:05/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm time out' }));
    expect(await screen.findByText('Time out recorded')).toBeInTheDocument();
  });

  it('tells the employee when attendance is already complete and records nothing', async () => {
    localStorage.setItem('cims.kioskDeviceToken', TOKEN);
    const { calls } = mockFetch({
      'GET /auth/me': unauthenticated,
      'GET /kiosk/status': status(true),
      'POST /kiosk/identify': () => ({
        status: 200,
        body: {
          status: 'COMPLETED',
          displayName: 'Ana S.',
          workDate: '2026-11-04',
          timeInAt: '2026-11-04T00:05:00.000Z',
          timeOutAt: '2026-11-04T09:05:00.000Z',
        },
      }),
    });
    renderKiosk();
    await enter('123');
    expect(await screen.findByText('Attendance already completed')).toBeInTheDocument();
    expect(screen.getByText(/in 8:05.*out 5:05/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/kiosk/confirm')).toBe(false);
  });

  it('cancels back to an empty form', async () => {
    localStorage.setItem('cims.kioskDeviceToken', TOKEN);
    mockFetch({
      'GET /auth/me': unauthenticated,
      'GET /kiosk/status': status(true),
      'POST /kiosk/identify': ready('TIME_IN'),
    });
    renderKiosk();
    await enter('123');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByLabelText('Employee number')).toHaveValue('');
    expect(screen.getByLabelText('PIN')).toHaveValue('');
  });

  it('shows the server reason and clears the PIN when identification fails', async () => {
    localStorage.setItem('cims.kioskDeviceToken', TOKEN);
    mockFetch({
      'GET /auth/me': unauthenticated,
      'GET /kiosk/status': status(true),
      'POST /kiosk/identify': () => ({
        status: 401,
        body: {
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid employee number or PIN' },
        },
      }),
    });
    renderKiosk();
    await enter('123');
    expect(await screen.findByText('Invalid employee number or PIN')).toBeInTheDocument();
    expect(screen.getByLabelText('PIN')).toHaveValue('');
    expect(screen.getByLabelText('Employee number')).toHaveValue('123');
  });

  it('validates the inputs before calling the API', async () => {
    localStorage.setItem('cims.kioskDeviceToken', TOKEN);
    const { calls } = mockFetch({
      'GET /auth/me': unauthenticated,
      'GET /kiosk/status': status(true),
    });
    renderKiosk();
    await enter('12a', '12');
    expect(screen.getByText(/Enter a valid employee number/)).toBeInTheDocument();
    expect(screen.getByText('PIN must be 6 digits')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/kiosk/identify')).toBe(false);
  });
});
