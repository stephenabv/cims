import type { CurrentUser, LeaveRequestView } from '@cims/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app/App';
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

const empty = { data: [], meta: { page: 1, pageSize: 20, total: 0 } };
const VL = {
  id: '00000000-0000-4000-8000-000000000121',
  code: 'VL',
  name: 'Vacation leave',
  isPaid: true,
};

function request(over: Partial<LeaveRequestView> = {}): LeaveRequestView {
  return {
    id: 'r1',
    version: 1,
    status: 'PENDING',
    employee: { id: 'e2', accountNumber: 'EMP-000124', fullName: 'Ben Cruz' },
    leaveType: VL,
    startDate: '2026-11-09',
    endDate: '2026-11-13',
    days: 5,
    reason: 'Family trip',
    submittedAt: '2026-11-05T02:00:00.000Z',
    decidedAt: null,
    endReason: null,
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
      {
        position: 2,
        kind: 'ROLE',
        approver: 'Human Resources',
        status: 'WAITING',
        actedBy: null,
        actedAt: null,
        note: null,
      },
    ],
    can: { decide: true, withdraw: false, cancel: false },
    ...over,
  };
}

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

// jsdom does not implement <dialog>.showModal, so dialog contents are queried with `hidden`.
describe('leave', () => {
  beforeEach(() => {
    document.cookie = 'cims_csrf=n.s';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('previews working days and files a request', async () => {
    const year = new Date().getFullYear();
    const { calls } = mockFetch({
      'GET /auth/me': () => ({ status: 200, body: me }),
      'GET /leave/requests/mine?page=1&pageSize=20': () => ({ status: 200, body: empty }),
      'GET /leave/requests/approvals?page=1&pageSize=1': () => ({
        status: 200,
        body: { ...empty, meta: { ...empty.meta, total: 2 } },
      }),
      [`GET /leave/balances/me/${year}`]: () => ({ status: 200, body: [] }),
      'GET /leave/types': () => ({
        status: 200,
        body: [{ ...VL, isActive: true, approvalChainId: null }],
      }),
      'POST /leave/preview': () => ({
        status: 200,
        body: { days: 4, dates: ['2026-11-09', '2026-11-10', '2026-11-12', '2026-11-13'] },
      }),
      'POST /leave/requests': () => ({ status: 201, body: request() }),
    });
    renderAt('/app/leave');

    expect(
      await screen.findByText(/2 leave requests are waiting for your approval/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Apply for leave' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Submit request', hidden: true }),
    );
    expect(within(dialog).getByText('Choose a leave type')).toBeInTheDocument();

    await userEvent.selectOptions(within(dialog).getByLabelText('Leave type'), VL.id);
    await userEvent.type(within(dialog).getByLabelText('First day'), '2026-11-09');
    await userEvent.clear(within(dialog).getByLabelText('Last day'));
    await userEvent.type(within(dialog).getByLabelText('Last day'), '2026-11-13');
    expect(await within(dialog).findByText(/4 working days/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Family trip');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Submit request', hidden: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument(),
    );
    expect(calls.find((c) => c.method === 'POST' && c.path === '/leave/requests')?.body).toEqual({
      leaveTypeId: VL.id,
      startDate: '2026-11-09',
      endDate: '2026-11-13',
      reason: 'Family trip',
    });
  });

  it('lets an approver reject with a reason, sending the version it saw', async () => {
    const { calls } = mockFetch({
      'GET /auth/me': () => ({ status: 200, body: me }),
      'GET /leave/requests/approvals?page=1&pageSize=20': () => ({
        status: 200,
        body: { data: [request({ version: 4 })], meta: { page: 1, pageSize: 20, total: 1 } },
      }),
      'POST /leave/requests/r1/decide': () => ({
        status: 200,
        body: request({ status: 'REJECTED' }),
      }),
    });
    renderAt('/app/leave/approvals');

    expect(await screen.findByText('Ben Cruz')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show approvals' }));
    expect(screen.getByText('Awaiting decision')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject', hidden: true }));
    expect(within(dialog).getByText('Explain why the request is rejected')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Team is short that week');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject', hidden: true }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument(),
    );
    expect(calls.find((c) => c.path === '/leave/requests/r1/decide')?.body).toEqual({
      decision: 'REJECT',
      note: 'Team is short that week',
      version: 4,
    });
  });
});
