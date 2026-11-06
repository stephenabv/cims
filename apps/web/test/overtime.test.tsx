import type { AttendanceRangeResult, CurrentUser, OvertimeRecordView } from '@cims/shared';
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

function record(over: Partial<OvertimeRecordView> = {}): OvertimeRecordView {
  return {
    id: 'o1',
    version: 3,
    status: 'PENDING',
    employee: { id: 'e2', accountNumber: 'EMP-000124', fullName: 'Ben Cruz', department: 'Sales' },
    workDate: '2026-11-04',
    firstIn: '2026-11-04T00:00:00.000Z',
    lastOut: '2026-11-04T10:30:00.000Z',
    actualMinutes: 90,
    approvedMinutes: null,
    history: [],
    can: { decide: true },
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
describe('overtime', () => {
  beforeEach(() => {
    document.cookie = 'cims_csrf=n.s';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('approves part of the overtime only with a reason, sending the version it saw', async () => {
    const { calls } = mockFetch({
      'GET /auth/me': () => ({ status: 200, body: me }),
      'GET /kiosk/status': kioskStatus,
      'GET /overtime?status=PENDING&page=1&pageSize=20': () => ({
        status: 200,
        body: { data: [record()], meta: { page: 1, pageSize: 20, total: 1 } },
      }),
      'POST /overtime/o1/decide': () => ({
        status: 200,
        body: record({ status: 'APPROVED', approvedMinutes: 60 }),
      }),
    });
    renderAt('/app/overtime');

    expect(await screen.findByText('Ben Cruz')).toBeInTheDocument();
    expect(screen.getByText(/8:00 AM – 6:30 PM · 1h 30m overtime/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    const amount = within(dialog).getByLabelText('Approved time (h:mm)');
    expect(amount).toHaveValue('1:30');
    await userEvent.clear(amount);
    await userEvent.type(amount, '2:00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve', hidden: true }));
    expect(within(dialog).getByText('At most 1:30 was worked')).toBeInTheDocument();

    await userEvent.clear(amount);
    await userEvent.type(amount, '1:00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve', hidden: true }));
    expect(within(dialog).getByText('Explain why only part is approved')).toBeInTheDocument();
    await userEvent.type(
      within(dialog).getByLabelText('Reason for approving part'),
      'Only the first hour was requested',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve', hidden: true }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument(),
    );
    expect(calls.find((c) => c.path === '/overtime/o1/decide')?.body).toEqual({
      decision: 'APPROVE',
      approvedMinutes: 60,
      note: 'Only the first hour was requested',
      version: 3,
    });
  });

  it('shows the status of my overtime and what waits for my approval', async () => {
    const day: AttendanceRangeResult['days'][number] = {
      workDate: '2026-11-04',
      status: 'PRESENT',
      firstIn: '2026-11-04T00:00:00.000Z',
      lastOut: '2026-11-04T10:30:00.000Z',
      workedMinutes: 570,
      regularMinutes: 480,
      lateMinutes: 0,
      undertimeMinutes: 0,
      overtimeMinutes: 90,
      scheduledMinutes: 480,
      punches: [],
    };
    mockFetch({
      'GET /auth/me': () => ({ status: 200, body: me }),
      'GET /attendance/me?from=2026-11-04&to=2026-11-04': () => ({
        status: 200,
        body: {
          employee: { id: 'e1', accountNumber: 'EMP-000123', fullName: 'Ana Santos' },
          timezone: 'Asia/Manila',
          days: [day],
          summary: {
            daysWorked: 1,
            totalWorkedMinutes: 570,
            totalLateMinutes: 0,
            lateCount: 0,
            totalUndertimeMinutes: 0,
            totalOvertimeMinutes: 90,
            absences: 0,
            incomplete: 0,
            leaveDays: 0,
          },
        } satisfies AttendanceRangeResult,
      }),
      'GET /overtime/mine?from=2026-11-04&to=2026-11-04&page=1&pageSize=100': () => ({
        status: 200,
        body: {
          data: [
            record({
              employee: { ...record().employee, id: 'e1' },
              status: 'APPROVED',
              approvedMinutes: 60,
              can: { decide: false },
            }),
          ],
          meta: { page: 1, pageSize: 100, total: 1 },
        },
      }),
      'GET /overtime/waiting': () => ({ status: 200, body: { count: 2 } }),
    });
    renderAt('/app/attendance?from=2026-11-04&to=2026-11-04');

    expect(
      await screen.findByText(/2 overtime records are waiting for your approval/),
    ).toBeInTheDocument();
    expect(await screen.findByText('Approved 1h')).toBeInTheDocument();
  });
});
