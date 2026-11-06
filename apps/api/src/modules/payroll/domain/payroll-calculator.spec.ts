import { calculatePay, type PayDay, type PayInput, type PayProfile } from './payroll-calculator';
import { divRound } from './money';

/** ₱100.00/h, 1.25× overtime, undertime at the hourly equivalent. */
const profile = (over: Partial<PayProfile> = {}): PayProfile => ({
  id: 'p1',
  effectiveFrom: '2026-01-01',
  hourlyRateCentavos: 10_000,
  overtimeRateKind: 'MULTIPLIER',
  overtimeMultiplierPermille: 1250,
  overtimeFixedRateCentavos: null,
  undertimePolicy: {
    name: 'Hourly-rate equivalent',
    kind: 'HOURLY_EQUIVALENT',
    blockMinutes: null,
    amountPerBlockCentavos: null,
    chargePartialBlock: true,
    tiers: null,
  },
  ...over,
});

const day = (date: string, over: Partial<PayDay> = {}): PayDay => ({
  date,
  kind: 'WORKED',
  scheduledMinutes: 480,
  lateMinutes: 0,
  undertimeMinutes: 0,
  approvedOvertimeMinutes: 0,
  pendingOvertimeMinutes: 0,
  ...over,
});

const input = (over: Partial<PayInput> = {}): PayInput => ({
  from: '2026-11-01',
  to: '2026-11-15',
  days: [],
  profiles: [profile()],
  items: [],
  undertimeThresholdMinutes: 0,
  ...over,
});

const amounts = (r: ReturnType<typeof calculatePay>) =>
  Object.fromEntries(r.lines.map((l) => [l.label, l.amountCentavos]));

describe('divRound', () => {
  it('rounds half away from zero and refuses unsafe numbers', () => {
    expect(divRound(5, 10)).toBe(1);
    expect(divRound(4, 10)).toBe(0);
    expect(divRound(-5, 10)).toBe(-1);
    expect(divRound(1_000_001, 60)).toBe(16_667);
    expect(() => divRound(Number.MAX_SAFE_INTEGER + 2, 3)).toThrow(RangeError);
  });
});

describe('calculatePay', () => {
  it('pays scheduled time of days worked plus approved overtime only', () => {
    const r = calculatePay(
      input({
        days: [
          day('2026-11-02', { approvedOvertimeMinutes: 90 }),
          day('2026-11-03', { pendingOvertimeMinutes: 60 }),
          day('2026-11-04', { kind: 'NONE' }), // absent
        ],
      }),
    );
    expect(amounts(r)).toEqual({
      'Regular pay': 160_000, // 16h × ₱100
      'Approved overtime': 18_750, // 1.5h × ₱125
    });
    expect(r).toMatchObject({
      grossCentavos: 178_750,
      deductionsCentavos: 0,
      netCentavos: 178_750,
    });
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: 'PENDING_OVERTIME', date: '2026-11-03' }),
    ]);
  });

  it('pays approved overtime on a rest day or holiday with no regular pay', () => {
    const r = calculatePay(
      input({ days: [day('2026-11-08', { scheduledMinutes: 0, approvedOvertimeMinutes: 240 })] }),
    );
    expect(amounts(r)).toEqual({ 'Approved overtime': 50_000 });
  });

  it('uses a fixed overtime rate when the profile has one', () => {
    const r = calculatePay(
      input({
        profiles: [
          profile({
            overtimeRateKind: 'FIXED',
            overtimeMultiplierPermille: null,
            overtimeFixedRateCentavos: 15_000,
          }),
        ],
        days: [day('2026-11-02', { approvedOvertimeMinutes: 30 })],
      }),
    );
    expect(amounts(r)['Approved overtime']).toBe(7_500);
  });

  it('pays paid leave at the scheduled hours and skips unpaid leave (A-9)', () => {
    const r = calculatePay(
      input({
        days: [
          day('2026-11-02', { kind: 'PAID_LEAVE' }),
          day('2026-11-03', { kind: 'UNPAID_LEAVE' }),
        ],
      }),
    );
    expect(amounts(r)).toEqual({ 'Paid leave': 80_000 });
  });

  it('deducts late and undertime at the hourly equivalent, honouring the threshold', () => {
    const r = calculatePay(
      input({
        undertimeThresholdMinutes: 30,
        days: [
          day('2026-11-02', { lateMinutes: 20 }), // late always counts
          day('2026-11-03', { undertimeMinutes: 20 }), // below threshold: ignored
          day('2026-11-04', { undertimeMinutes: 45, lateMinutes: 15 }),
        ],
      }),
    );
    const ut = r.lines.find((l) => l.kind === 'UNDERTIME')!;
    expect(ut.minutes).toBe(80);
    expect(ut.amountCentavos).toBe(-(3_333 + 10_000)); // 20m → ₱33.33; 60m → ₱100
    expect(ut.detail).toContain('2 days');
    expect(r.netCentavos).toBe(240_000 - 13_333);
  });

  it('prices undertime per block, with or without partial blocks', () => {
    const block = (chargePartialBlock: boolean) =>
      profile({
        undertimePolicy: {
          name: '₱50 per 30 minutes',
          kind: 'FIXED_PER_BLOCK',
          blockMinutes: 30,
          amountPerBlockCentavos: 5_000,
          chargePartialBlock,
          tiers: null,
        },
      });
    const days = [day('2026-11-02', { undertimeMinutes: 45 })];
    expect(calculatePay(input({ profiles: [block(true)], days })).deductionsCentavos).toBe(10_000);
    expect(calculatePay(input({ profiles: [block(false)], days })).deductionsCentavos).toBe(5_000);
  });

  it('prices undertime by tier, and beyond the last tier at the hourly equivalent', () => {
    const tiered = profile({
      undertimePolicy: {
        name: 'Company table',
        kind: 'TIERED',
        blockMinutes: null,
        amountPerBlockCentavos: null,
        chargePartialBlock: true,
        tiers: [
          { upToMinutes: 15, amountCentavos: 2_000 },
          { upToMinutes: 60, amountCentavos: 8_000 },
        ],
      },
    });
    const ut = (m: number) =>
      calculatePay(
        input({ profiles: [tiered], days: [day('2026-11-02', { undertimeMinutes: m })] }),
      ).deductionsCentavos;
    expect(ut(10)).toBe(2_000);
    expect(ut(15)).toBe(2_000);
    expect(ut(16)).toBe(8_000);
    expect(ut(90)).toBe(15_000);
  });

  it('never deducts more than a day’s regular pay', () => {
    const steep = profile({
      undertimePolicy: {
        name: 'Steep',
        kind: 'FIXED_PER_BLOCK',
        blockMinutes: 1,
        amountPerBlockCentavos: 100_000,
        chargePartialBlock: true,
        tiers: null,
      },
    });
    const r = calculatePay(
      input({ profiles: [steep], days: [day('2026-11-02', { lateMinutes: 5 })] }),
    );
    expect(r.deductionsCentavos).toBe(80_000); // the whole day, not 5 × ₱1,000
    expect(r.lines.find((l) => l.kind === 'UNDERTIME')!.detail).toContain('capped');
  });

  it('applies a mid-period raise from its effective date as separate lines', () => {
    const r = calculatePay(
      input({
        profiles: [
          profile({ id: 'p2', effectiveFrom: '2026-11-03', hourlyRateCentavos: 12_000 }),
          profile(),
        ],
        days: [day('2026-11-02'), day('2026-11-03'), day('2026-11-04')],
      }),
    );
    expect(amounts(r)).toEqual({
      'Regular pay (rate from 2026-01-01)': 80_000,
      'Regular pay (rate from 2026-11-03)': 192_000,
    });
  });

  it('warns about days without a profile and incomplete days, and pays neither', () => {
    const r = calculatePay(
      input({
        profiles: [profile({ effectiveFrom: '2026-11-03' })],
        days: [day('2026-11-02'), day('2026-11-03', { kind: 'INCOMPLETE' }), day('2026-11-04')],
      }),
    );
    expect(r.grossCentavos).toBe(80_000);
    expect(r.warnings.map((w) => [w.code, w.date])).toEqual([
      ['NO_PROFILE', '2026-11-02'],
      ['INCOMPLETE_DAY', '2026-11-03'],
    ]);
  });

  it('adds allowances to gross and takes fixed and percentage deductions from earned pay', () => {
    const r = calculatePay(
      input({
        days: [day('2026-11-02', { lateMinutes: 60 })],
        items: [
          {
            label: 'Rice allowance',
            direction: 'ALLOWANCE',
            calculation: 'FIXED',
            amountCentavos: 20_000,
            rateBasisPoints: null,
          },
          {
            label: 'SSS contribution',
            direction: 'DEDUCTION',
            calculation: 'FIXED',
            amountCentavos: 5_000,
            rateBasisPoints: null,
          },
          {
            label: 'PhilHealth contribution',
            direction: 'DEDUCTION',
            calculation: 'PERCENT_OF_GROSS',
            amountCentavos: null,
            rateBasisPoints: 250,
          },
        ],
      }),
    );
    // Gross ₱1,000 (₱800 + ₱200); earned after ₱100 late = ₱900; 2.5% = ₱22.50.
    expect(r.grossCentavos).toBe(100_000);
    expect(amounts(r)['PhilHealth contribution']).toBe(-2_250);
    expect(r.deductionsCentavos).toBe(10_000 + 5_000 + 2_250);
    expect(r.netCentavos).toBe(82_750);
  });

  it('flags a negative net instead of hiding it', () => {
    const r = calculatePay(
      input({
        items: [
          {
            label: 'Loan',
            direction: 'DEDUCTION',
            calculation: 'FIXED',
            amountCentavos: 5_000,
            rateBasisPoints: null,
          },
        ],
      }),
    );
    expect(r.netCentavos).toBe(-5_000);
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_NET' })]);
  });
});
