import type {
  PayItemCalculation,
  PayItemDirection,
  PayLine,
  PayWarning,
  PayrollCalculation,
} from '@cims/shared';
import { divRound, formatDuration, formatPeso, payForMinutes } from './money';
import { type UndertimePolicyConfig, undertimeRuleFor } from './undertime-policy';

/** One calendar day of the period, as attendance, leave and the schedule describe it. */
export interface PayDay {
  date: string;
  /**
   * WORKED: completed attendance. INCOMPLETE: a punch is missing (not paid until corrected).
   * PAID_LEAVE / UNPAID_LEAVE: approved leave. NONE: rest day, holiday or absence.
   */
  kind: 'WORKED' | 'INCOMPLETE' | 'PAID_LEAVE' | 'UNPAID_LEAVE' | 'NONE';
  /** Paid working time the schedule expects that day, after the break. */
  scheduledMinutes: number;
  lateMinutes: number;
  undertimeMinutes: number;
  approvedOvertimeMinutes: number;
  pendingOvertimeMinutes: number;
}

export interface PayProfile {
  id: string;
  effectiveFrom: string;
  hourlyRateCentavos: number;
  overtimeRateKind: 'MULTIPLIER' | 'FIXED';
  overtimeMultiplierPermille: number | null;
  overtimeFixedRateCentavos: number | null;
  undertimePolicy: UndertimePolicyConfig & { name: string };
}

export interface PayItem {
  label: string;
  direction: PayItemDirection;
  calculation: PayItemCalculation;
  amountCentavos: number | null;
  rateBasisPoints: number | null;
}

export interface PayInput {
  from: string;
  to: string;
  days: PayDay[];
  /** All versions of the employee's profile, any order; each day uses the latest that started. */
  profiles: PayProfile[];
  /** Allowances and deductions in force for the period. */
  items: PayItem[];
  /** Daily undertime below this is not deducted (late minutes are always deducted). */
  undertimeThresholdMinutes: number;
}

interface Bucket {
  profile: PayProfile;
  regular: number;
  leave: number;
  overtime: number;
  undertimeMinutes: number;
  undertimeDays: number;
  undertimeCentavos: number;
  undertimeDetails: string[];
}

/**
 * Computes one employee's pay for a period (spec §3.4, owner decision on Q-2, assumptions A-9,
 * A-12, A-13). Pure and deterministic: the same input always gives the same lines.
 *
 * - Regular pay: scheduled minutes of each day worked × hourly rate.
 * - Paid leave: scheduled minutes of each paid-leave day × hourly rate (A-9).
 * - Overtime: approved minutes only (BR-13) × overtime rate.
 * - Undertime: each day's late minutes plus undertime at or above the threshold, priced by the
 *   profile's undertime policy, never more than that day's regular pay (A-13).
 * - Allowances are fixed amounts. Deductions are fixed or a percentage of earned pay
 *   (gross minus undertime).
 *
 * Time is grouped per profile version, so a raise in the middle of a period shows as two lines.
 */
export function calculatePay(input: PayInput): PayrollCalculation {
  const profiles = [...input.profiles].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0,
  );
  const profileOn = (date: string) => profiles.filter((p) => p.effectiveFrom <= date).at(-1);
  const buckets = new Map<string, Bucket>();
  const warnings: PayWarning[] = [];

  for (const day of [...input.days].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (day.pendingOvertimeMinutes > 0)
      warnings.push({
        code: 'PENDING_OVERTIME',
        date: day.date,
        message: `${formatDuration(day.pendingOvertimeMinutes)} of overtime is still awaiting approval and is not paid`,
      });
    if (day.kind === 'INCOMPLETE') {
      warnings.push({
        code: 'INCOMPLETE_DAY',
        date: day.date,
        message: 'A time-in or time-out is missing; the day is not paid until it is corrected',
      });
      continue;
    }
    const paysTime =
      (day.kind === 'WORKED' && (day.scheduledMinutes > 0 || day.approvedOvertimeMinutes > 0)) ||
      (day.kind === 'PAID_LEAVE' && day.scheduledMinutes > 0);
    if (!paysTime) continue;

    const profile = profileOn(day.date);
    if (!profile) {
      warnings.push({
        code: 'NO_PROFILE',
        date: day.date,
        message: 'No pay profile was in force; the day is not paid',
      });
      continue;
    }
    let b = buckets.get(profile.id);
    if (!b) {
      b = {
        profile,
        regular: 0,
        leave: 0,
        overtime: 0,
        undertimeMinutes: 0,
        undertimeDays: 0,
        undertimeCentavos: 0,
        undertimeDetails: [],
      };
      buckets.set(profile.id, b);
    }

    if (day.kind === 'PAID_LEAVE') {
      b.leave += day.scheduledMinutes;
      continue;
    }
    b.regular += day.scheduledMinutes;
    b.overtime += day.approvedOvertimeMinutes;

    const counted =
      day.lateMinutes +
      (day.undertimeMinutes > 0 && day.undertimeMinutes >= input.undertimeThresholdMinutes
        ? day.undertimeMinutes
        : 0);
    if (counted > 0 && day.scheduledMinutes > 0) {
      const rule = undertimeRuleFor(profile.undertimePolicy);
      const charge = rule.charge(counted, profile.hourlyRateCentavos);
      const dayPay = payForMinutes(day.scheduledMinutes, profile.hourlyRateCentavos);
      const amount = Math.min(charge.amountCentavos, dayPay);
      b.undertimeMinutes += counted;
      b.undertimeDays += 1;
      b.undertimeCentavos += amount;
      b.undertimeDetails.push(
        `${day.date}: ${charge.detail} = ${formatPeso(amount)}${amount < charge.amountCentavos ? ' (capped at the day’s pay)' : ''}`,
      );
    }
  }

  const lines: PayLine[] = [];
  const several = buckets.size > 1;
  const since = (p: PayProfile) => (several ? ` (rate from ${p.effectiveFrom})` : '');
  for (const b of buckets.values()) {
    const rate = b.profile.hourlyRateCentavos;
    if (b.regular > 0)
      lines.push({
        kind: 'REGULAR',
        label: `Regular pay${since(b.profile)}`,
        minutes: b.regular,
        amountCentavos: payForMinutes(b.regular, rate),
        detail: `${formatDuration(b.regular)} at ${formatPeso(rate)}/h`,
      });
    if (b.leave > 0)
      lines.push({
        kind: 'PAID_LEAVE',
        label: `Paid leave${since(b.profile)}`,
        minutes: b.leave,
        amountCentavos: payForMinutes(b.leave, rate),
        detail: `${formatDuration(b.leave)} at ${formatPeso(rate)}/h`,
      });
    if (b.overtime > 0) {
      const p = b.profile;
      const amount =
        p.overtimeRateKind === 'MULTIPLIER'
          ? divRound(b.overtime * rate * (p.overtimeMultiplierPermille ?? 1000), 60_000)
          : payForMinutes(b.overtime, p.overtimeFixedRateCentavos ?? 0);
      lines.push({
        kind: 'OVERTIME',
        label: `Approved overtime${since(p)}`,
        minutes: b.overtime,
        amountCentavos: amount,
        detail:
          p.overtimeRateKind === 'MULTIPLIER'
            ? `${formatDuration(b.overtime)} at ${formatPeso(rate)}/h × ${(p.overtimeMultiplierPermille ?? 1000) / 1000}`
            : `${formatDuration(b.overtime)} at ${formatPeso(p.overtimeFixedRateCentavos ?? 0)}/h`,
      });
    }
  }

  for (const item of input.items.filter((i) => i.direction === 'ALLOWANCE')) {
    lines.push({
      kind: 'ALLOWANCE',
      label: item.label,
      minutes: null,
      amountCentavos: item.amountCentavos ?? 0,
      detail: 'Fixed amount',
    });
  }
  const grossCentavos = lines.reduce((sum, l) => sum + l.amountCentavos, 0);

  let undertimeCentavos = 0;
  for (const b of buckets.values()) {
    if (b.undertimeCentavos === 0 && b.undertimeMinutes === 0) continue;
    undertimeCentavos += b.undertimeCentavos;
    lines.push({
      kind: 'UNDERTIME',
      label: `Late and undertime (${b.profile.undertimePolicy.name})`,
      minutes: b.undertimeMinutes,
      amountCentavos: -b.undertimeCentavos,
      detail: `${b.undertimeDays} ${b.undertimeDays === 1 ? 'day' : 'days'}. ${b.undertimeDetails.join('; ')}`,
    });
  }

  const earned = grossCentavos - undertimeCentavos;
  let otherDeductions = 0;
  for (const item of input.items.filter((i) => i.direction === 'DEDUCTION')) {
    const amount =
      item.calculation === 'FIXED'
        ? (item.amountCentavos ?? 0)
        : divRound(Math.max(0, earned) * (item.rateBasisPoints ?? 0), 10_000);
    otherDeductions += amount;
    lines.push({
      kind: 'DEDUCTION',
      label: item.label,
      minutes: null,
      amountCentavos: -amount,
      detail:
        item.calculation === 'FIXED'
          ? 'Fixed amount'
          : `${(item.rateBasisPoints ?? 0) / 100}% of ${formatPeso(Math.max(0, earned))} earned pay`,
    });
  }

  const deductionsCentavos = undertimeCentavos + otherDeductions;
  const netCentavos = grossCentavos - deductionsCentavos;
  if (netCentavos < 0)
    warnings.push({
      code: 'NEGATIVE_NET',
      date: null,
      message: `Deductions exceed pay by ${formatPeso(-netCentavos)}`,
    });

  return {
    from: input.from,
    to: input.to,
    lines,
    grossCentavos,
    deductionsCentavos,
    netCentavos,
    warnings,
  };
}
