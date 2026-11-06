import type { AttendanceRangeResult, CurrentUser } from '@cims/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app/App';
import { AuthProvider } from '@/lib/auth';
import { mockFetch } from './fetch-mock';

const hr: CurrentUser = {
  id: 'u1',
  employeeId: 'e1',
  accountNumber: 'EMP-000001',
  fullName: 'Hana Reyes',
  email: 'hr@acme.test',
  role: { key: 'HR', name: 'HR' },
  permissions: ['attendance.view.all', 'attendance.adjust'],
  mustChangePassword: false,
  mfaEnabled: true,
  mfaRequired: true,
};

const RANGE = '?from=2026-11-04&to=2026-11-04';

function range(employeeId: string): AttendanceRangeResult {
  return {
    employee: { id: employeeId, accountNumber: 'EMP-000123', fullName: 'Ana Santos' },
    timezone: 'Asia/Manila',
    days: [
      {
        workDate: '2026-11-04',
        status: 'INCOMPLETE',
        firstIn: '2026-11-04T00:05:00.000Z',
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
            occurredAt: '2026-11-04T00:05:00.000Z',
            source: 'KIOSK_ONLINE',
            status: 'ACCEPTED',
            note: null,
          },
          {
            id: 'p0',
            type: 'TIME_OUT',
            occurredAt: '2026-11-04T00:06:00.000Z',
            source: 'KIOSK_ONLINE',
            status: 'VOIDED',
            note: 'Pressed the wrong button',
          },
        ],
      },
    ],
    summary: {
      daysWorked: 1,
      totalWorkedMinutes: 0,
      totalLateMinutes: 0,
      lateCount: 0,
      totalUndertimeMinutes: 0,
      totalOvertimeMinutes: 0,
      absences: 0,
      incomplete: 1,
      leaveDays: 0,
    },
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

describe('HR attendance adjustments', () => {
  beforeEach(() => {
    document.cookie = 'cims_csrf=n.s';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows punches with notes and lets HR add and void with a reason', async () => {
    // jsdom does not implement <dialog>.showModal, so dialogs are queried with `hidden`.
    const { calls } = mockFetch({
      'GET /auth/me': () => ({ status: 200, body: hr }),
      [`GET /attendance/employees/e2${RANGE}`]: () => ({ status: 200, body: range('e2') }),
      'POST /attendance/punches/p1/void': () => ({ status: 204 }),
      'POST /attendance/employees/e2/punches': () => ({
        status: 201,
        body: { id: 'p9', workDate: '2026-11-04' },
      }),
    });
    renderAt(`/app/attendance/employees/e2${RANGE}`);

    await userEvent.click(await screen.findByRole('button', { name: /Punches for/ }));
    expect(screen.getByText('“Pressed the wrong button”')).toBeInTheDocument();
    expect(screen.getByText('Voided')).toBeInTheDocument();
    // Only the accepted punch can be voided.
    expect(screen.getAllByRole('button', { name: /^Void / })).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /^Void time in/ }));
    const voidDialog = await screen.findByRole('dialog', { hidden: true });
    await userEvent.click(
      within(voidDialog).getByRole('button', { name: 'Void punch', hidden: true }),
    );
    expect(await within(voidDialog).findByText('Give a reason')).toBeInTheDocument();
    await userEvent.type(within(voidDialog).getByLabelText('Reason'), 'Duplicate tap');
    await userEvent.click(
      within(voidDialog).getByRole('button', { name: 'Void punch', hidden: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument(),
    );
    expect(calls.find((c) => c.path === '/attendance/punches/p1/void')?.body).toEqual({
      reason: 'Duplicate tap',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Add punch' }));
    const addDialog = await screen.findByRole('dialog', { hidden: true });
    await userEvent.selectOptions(within(addDialog).getByLabelText('Type'), 'TIME_OUT');
    await userEvent.type(within(addDialog).getByLabelText('Time'), '17:00');
    await userEvent.type(within(addDialog).getByLabelText('Reason'), 'Forgot to punch out');
    await userEvent.click(
      within(addDialog).getByRole('button', { name: 'Add punch', hidden: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument(),
    );
    expect(calls.find((c) => c.path === '/attendance/employees/e2/punches')?.body).toEqual({
      type: 'TIME_OUT',
      date: '2026-11-04',
      time: '17:00',
      reason: 'Forgot to punch out',
    });
  });

  it('offers no corrections on your own record', async () => {
    mockFetch({
      'GET /auth/me': () => ({ status: 200, body: hr }),
      [`GET /attendance/employees/e1${RANGE}`]: () => ({ status: 200, body: range('e1') }),
    });
    renderAt(`/app/attendance/employees/e1${RANGE}`);
    await userEvent.click(await screen.findByRole('button', { name: /Punches for/ }));
    expect(screen.getByText('“Pressed the wrong button”')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add punch' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Void / })).not.toBeInTheDocument();
  });
});
