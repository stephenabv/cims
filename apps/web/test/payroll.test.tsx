import type {
  CompensationOverview,
  CurrentUser,
  PayItemTypeView,
  PayrollPreview,
  UndertimePolicyView,
} from '@cims/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app/App';
import { currentHalf } from '@/features/payroll/PayPreviewSection';
import { AuthProvider } from '@/lib/auth';
import { todayIn } from '@/lib/datetime';
import { mockFetch } from './fetch-mock';

const hr: CurrentUser = {
  id: 'u1',
  employeeId: 'e1',
  accountNumber: 'EMP-000001',
  fullName: 'Hana Reyes',
  email: 'hana@acme.test',
  role: { key: 'HR', name: 'HR' },
  permissions: ['payroll.compensation.view', 'payroll.compensation.edit'],
  mustChangePassword: false,
  mfaEnabled: true,
  mfaRequired: true,
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

const policies: UndertimePolicyView[] = [
  {
    id: 'p-default',
    name: 'Hourly-rate equivalent',
    kind: 'HOURLY_EQUIVALENT',
    blockMinutes: null,
    amountPerBlockCentavos: null,
    chargePartialBlock: true,
    tiers: null,
    isDefault: true,
    isActive: true,
  },
];

const phic: PayItemTypeView = {
  id: 't-phic',
  code: 'PHIC',
  name: 'PhilHealth contribution',
  direction: 'DEDUCTION',
  isActive: true,
};

function overview(
  employeeId = 'e2',
  over: Partial<CompensationOverview> = {},
): CompensationOverview {
  return {
    employee: {
      id: employeeId,
      accountNumber: 'EMP-000002',
      fullName: 'Maria Lopez',
      department: 'Engineering',
      position: null,
      classification: 'REGULAR',
    },
    profiles: [],
    items: [],
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
describe('pay setup', () => {
  beforeEach(() => {
    document.cookie = 'cims_csrf=n.s';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sets pay terms in centavos and per mille, using the default late policy', async () => {
    const { calls } = mockFetch({
      'GET /auth/me': () => ({ status: 200, body: hr }),
      'GET /kiosk/status': kioskStatus,
      'GET /payroll/compensation/e2': () => ({ status: 200, body: overview() }),
      'GET /payroll/undertime-policies': () => ({ status: 200, body: policies }),
      'POST /payroll/compensation/e2/profiles': () => ({ status: 201, body: overview() }),
    });
    renderAt('/app/payroll/employees/e2');

    expect(await screen.findByText('No pay terms yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set pay terms' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }));
    expect(within(dialog).getByText('Pick the first day these terms apply')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter an amount such as 125.50')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Applies from'), '2026-11-01');
    await userEvent.type(within(dialog).getByLabelText('Hourly rate (₱)'), '1,125.5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument(),
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      effectiveFrom: '2026-11-01',
      hourlyRateCentavos: 112550,
      paySchedule: 'SEMI_MONTHLY',
      overtimeRateKind: 'MULTIPLIER',
      overtimeMultiplierPermille: 1250,
      overtimeFixedRateCentavos: null,
      undertimePolicyId: 'p-default',
    });
  });

  it('adds a percentage deduction and calculates pay for the current half-month', async () => {
    const { from, to } = currentHalf(todayIn('Asia/Manila'));
    const preview: PayrollPreview = {
      employee: { id: 'e2', accountNumber: 'EMP-000002', fullName: 'Maria Lopez' },
      from,
      to,
      lines: [
        {
          kind: 'REGULAR',
          label: 'Regular pay',
          minutes: 960,
          amountCentavos: 200000,
          detail: '16h at ₱125.00/h',
        },
        {
          kind: 'DEDUCTION',
          label: 'PhilHealth contribution',
          minutes: null,
          amountCentavos: -5000,
          detail: '2.5% of ₱2,000.00 earned pay',
        },
      ],
      grossCentavos: 200000,
      deductionsCentavos: 5000,
      netCentavos: 195000,
      warnings: [
        {
          code: 'INCOMPLETE_DAY',
          date: from,
          message: 'A time-in or time-out is missing; the day is not paid until it is corrected',
        },
      ],
    };
    const { calls } = mockFetch({
      'GET /auth/me': () => ({ status: 200, body: hr }),
      'GET /kiosk/status': kioskStatus,
      'GET /payroll/compensation/e2': () => ({ status: 200, body: overview() }),
      'GET /payroll/item-types': () => ({ status: 200, body: [phic] }),
      'POST /payroll/compensation/e2/items': () => ({ status: 201, body: overview() }),
      [`GET /payroll/compensation/e2/preview?from=${from}&to=${to}`]: () => ({
        status: 200,
        body: preview,
      }),
    });
    renderAt('/app/payroll/employees/e2');

    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await userEvent.selectOptions(within(dialog).getByLabelText('Type'), 't-phic');
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Calculated as'),
      'PERCENT_OF_GROSS',
    );
    await userEvent.type(within(dialog).getByLabelText('Percentage'), '2.5');
    await userEvent.type(within(dialog).getByLabelText('From'), '2026-11-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add', hidden: true }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument(),
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      typeId: 't-phic',
      calculation: 'PERCENT_OF_GROSS',
      amountCentavos: null,
      rateBasisPoints: 250,
      effectiveFrom: '2026-11-01',
      effectiveTo: null,
    });

    // The calculation is audited, so it runs only when asked.
    expect(calls.some((c) => c.path.includes('/preview'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    expect(await screen.findByText('₱1,950.00')).toBeInTheDocument();
    expect(screen.getByText('2.5% of ₱2,000.00 earned pay')).toBeInTheDocument();
    expect(screen.getByText('Missing punch')).toBeInTheDocument();
  });

  it('shows my own pay without change controls', async () => {
    mockFetch({
      'GET /auth/me': () => ({ status: 200, body: hr }),
      'GET /kiosk/status': kioskStatus,
      'GET /payroll/compensation/e1': () => ({ status: 200, body: overview('e1') }),
    });
    renderAt('/app/payroll/employees/e1');

    expect(
      await screen.findByText('You can view your own pay here, but someone else has to change it.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set pay terms' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('saves a tiered late and undertime policy in centavos', async () => {
    const { calls } = mockFetch({
      'GET /auth/me': () => ({
        status: 200,
        body: { ...hr, permissions: ['payroll.configure'] },
      }),
      'GET /payroll/undertime-policies': () => ({ status: 200, body: policies }),
      'GET /payroll/item-types': () => ({ status: 200, body: [phic] }),
      'POST /payroll/undertime-policies': () => ({ status: 201, body: policies[0] }),
    });
    renderAt('/app/payroll/settings');

    await userEvent.click(await screen.findByRole('button', { name: 'Add policy' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Company table');
    await userEvent.selectOptions(within(dialog).getByLabelText('Deduct by'), 'TIERED');
    await userEvent.type(within(dialog).getByLabelText('Up to (min) — tier 1'), '15');
    await userEvent.type(within(dialog).getAllByLabelText('Deduct (₱)')[0]!, '50');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add tier', hidden: true }));
    await userEvent.type(within(dialog).getByLabelText('Up to (min) — tier 2'), '30');
    await userEvent.type(within(dialog).getAllByLabelText('Deduct (₱)')[1]!, '120.75');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument(),
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Company table',
      kind: 'TIERED',
      blockMinutes: null,
      amountPerBlockCentavos: null,
      chargePartialBlock: true,
      tiers: [
        { upToMinutes: 15, amountCentavos: 5000 },
        { upToMinutes: 30, amountCentavos: 12075 },
      ],
      isActive: true,
    });
  });
});
