import type { AttendanceDayView, CorrectionRequestView, CurrentUser } from '@cims/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app/App';
import { RequestCorrectionDialog } from '@/features/corrections/RequestCorrectionDialog';
import { AuthProvider } from '@/lib/auth';
import { mockFetch } from './fetch-mock';

const me: CurrentUser = {
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

const kioskStatus = () => ({
  status: 200,
  body: {
    device: null,
    acceptsPunches: false,
    companyName: 'Acme Corp',
    timezone: 'Asia/Manila',
    serverTime: '2026-11-06T02:00:00.000Z',
  },
});

const empty = { status: 200, body: { data: [], meta: { page: 1, pageSize: 20, total: 0 } } };

function request(over: Partial<CorrectionRequestView> = {}): CorrectionRequestView {
  return {
    id: 'c1',
    version: 2,
    status: 'PENDING',
    type: 'CHANGE_TIME_IN',
    punchType: 'TIME_IN',
    employee: { id: 'e2', accountNumber: 'EMP-000124', fullName: 'Ben Cruz' },
    workDate: '2026-11-04',
    timezone: 'Asia/Manila',
    originalAt: '2026-11-04T01:20:00.000Z',
    requestedAt: '2026-11-04T00:05:00.000Z',
    appliedAt: null,
    reason: 'The kiosk was offline when I arrived.',
    submittedAt: '2026-11-04T09:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    currentPunches: [
      {
        id: 'p1',
        type: 'TIME_IN',
        occurredAt: '2026-11-04T01:20:00.000Z',
        source: 'KIOSK',
        status: 'ACCEPTED',
      },
    ],
    steps: [
      {
        position: 1,
        kind: 'SUPERVISOR',
        approver: 'Ana Santos',
        status: 'PENDING',
        actedBy: null,
        actedAt: null,
        note: null,
      },
    ],
    can: { decide: true, cancel: false },
    ...over,
  };
}

function wrap(ui: React.ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

// jsdom does not implement <dialog>.showModal, so dialog contents are queried with `hidden`.
describe('attendance corrections', () => {
  beforeEach(() => {
    document.cookie = 'cims_csrf=n.s';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the original and requested values side by side and rejects only with a reason', async () => {
    const { calls } = mockFetch({
      'GET /auth/me': () => ({ status: 200, body: me }),
      'GET /kiosk/status': kioskStatus,
      'GET /notifications': () => ({ status: 200, body: { data: [], unread: 0 } }),
      'GET /attendance/corrections/approvals?page=1&pageSize=20': () => ({
        status: 200,
        body: { data: [request()], meta: { page: 1, pageSize: 20, total: 1 } },
      }),
      'GET /attendance/corrections/mine?page=1&pageSize=20': () => empty,
      'POST /attendance/corrections/c1/decision': () => ({
        status: 200,
        body: request({ status: 'REJECTED', decisionNote: 'Badge log shows 9:20' }),
      }),
    });
    wrap(<AppRoutes />, '/app/attendance/corrections?tab=review');

    expect(await screen.findByText('Ben Cruz')).toBeInTheDocument();
    expect(screen.getByText('9:20 AM')).toBeInTheDocument();
    expect(screen.getByText('8:05 AM')).toBeInTheDocument();
    expect(screen.getByText(/kiosk was offline/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject', hidden: true }));
    expect(within(dialog).getByText('Explain why the request is rejected')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await userEvent.type(
      within(dialog).getByLabelText('Reason for rejecting', { selector: 'textarea' }),
      'Badge log shows 9:20',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject', hidden: true }));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        decision: 'REJECT',
        note: 'Badge log shows 9:20',
        version: 2,
      }),
    );
  });

  it('files a missing time out with the date, time and reason, and requires the reason', async () => {
    const day: AttendanceDayView = {
      workDate: '2026-11-04',
      status: 'INCOMPLETE',
      firstIn: '2026-11-04T00:02:00.000Z',
      lastOut: null,
      workedMinutes: 0,
      regularMinutes: 0,
      lateMinutes: 0,
      undertimeMinutes: 0,
      overtimeMinutes: 0,
      scheduledMinutes: 480,
      punches: [
        {
          id: 'p1',
          type: 'TIME_IN',
          occurredAt: '2026-11-04T00:02:00.000Z',
          source: 'KIOSK',
          status: 'ACCEPTED',
          note: null,
        },
      ],
    } as AttendanceDayView;
    const { calls } = mockFetch({
      'GET /auth/me': () => ({ status: 200, body: me }),
      'POST /attendance/corrections': () => ({
        status: 201,
        body: request({ type: 'MISSING_TIME_OUT' }),
      }),
    });
    const onClose = vi.fn();
    wrap(<RequestCorrectionDialog day={day} timezone="Asia/Manila" onClose={onClose} />);

    const dialog = await screen.findByRole('dialog', { hidden: true });
    const type = within(dialog).getByLabelText('What needs correcting?') as HTMLSelectElement;
    expect(type.value).toBe('MISSING_TIME_OUT');
    // A time in exists, so "missing time in" is not offered.
    expect(
      within(type).queryByRole('option', { name: 'Missing time in', hidden: true }),
    ).toBeNull();

    await userEvent.type(within(dialog).getByLabelText('Correct time'), '17:30');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Submit request', hidden: true }),
    );
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await userEvent.type(
      within(dialog).getByLabelText('Reason', { selector: 'textarea' }),
      'Forgot to time out before leaving.',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Submit request', hidden: true }),
    );
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      workDate: '2026-11-04',
      type: 'MISSING_TIME_OUT',
      requestedDate: '2026-11-04',
      requestedTime: '17:30',
      reason: 'Forgot to time out before leaving.',
    });
  });
});
