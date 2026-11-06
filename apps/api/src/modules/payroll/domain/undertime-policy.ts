import type { UndertimeTier } from '@cims/shared';
import { formatDuration, formatPeso, payForMinutes } from './money';

/** One day's deduction and how it was reached. */
export interface UndertimeCharge {
  amountCentavos: number;
  detail: string;
}

/**
 * Undertime deduction rules (spec §3.4 "Undertime Management"; strategy pattern). Each rule
 * prices one day's missed minutes; the calculator applies it day by day so the breakdown shows
 * exactly what each day cost.
 */
export interface UndertimeRule {
  charge(minutes: number, hourlyRateCentavos: number): UndertimeCharge;
}

export class HourlyEquivalentRule implements UndertimeRule {
  charge(minutes: number, hourlyRateCentavos: number): UndertimeCharge {
    return {
      amountCentavos: payForMinutes(minutes, hourlyRateCentavos),
      detail: `${formatDuration(minutes)} at ${formatPeso(hourlyRateCentavos)}/h`,
    };
  }
}

export class FixedPerBlockRule implements UndertimeRule {
  constructor(
    private readonly blockMinutes: number,
    private readonly amountPerBlockCentavos: number,
    private readonly chargePartialBlock: boolean,
  ) {
    if (blockMinutes < 1) throw new RangeError('blockMinutes must be at least 1');
  }

  charge(minutes: number): UndertimeCharge {
    const blocks = this.chargePartialBlock
      ? Math.ceil(minutes / this.blockMinutes)
      : Math.floor(minutes / this.blockMinutes);
    return {
      amountCentavos: blocks * this.amountPerBlockCentavos,
      detail: `${formatDuration(minutes)} = ${blocks} × ${formatPeso(this.amountPerBlockCentavos)} per ${this.blockMinutes}m`,
    };
  }
}

/** The first tier whose limit covers the minutes; beyond the last tier, the hourly equivalent. */
export class TieredRule implements UndertimeRule {
  private readonly fallback = new HourlyEquivalentRule();

  constructor(private readonly tiers: readonly UndertimeTier[]) {
    if (tiers.length === 0) throw new RangeError('at least one tier is required');
  }

  charge(minutes: number, hourlyRateCentavos: number): UndertimeCharge {
    const tier = this.tiers.find((t) => minutes <= t.upToMinutes);
    if (tier)
      return {
        amountCentavos: tier.amountCentavos,
        detail: `${formatDuration(minutes)}: tier up to ${tier.upToMinutes}m`,
      };
    const beyond = this.fallback.charge(minutes, hourlyRateCentavos);
    return { ...beyond, detail: `${beyond.detail} (beyond the last tier)` };
  }
}

export interface UndertimePolicyConfig {
  kind: 'HOURLY_EQUIVALENT' | 'FIXED_PER_BLOCK' | 'TIERED';
  blockMinutes: number | null;
  amountPerBlockCentavos: number | null;
  chargePartialBlock: boolean;
  tiers: UndertimeTier[] | null;
}

export function undertimeRuleFor(policy: UndertimePolicyConfig): UndertimeRule {
  switch (policy.kind) {
    case 'HOURLY_EQUIVALENT':
      return new HourlyEquivalentRule();
    case 'FIXED_PER_BLOCK':
      return new FixedPerBlockRule(
        policy.blockMinutes ?? 0,
        policy.amountPerBlockCentavos ?? 0,
        policy.chargePartialBlock,
      );
    case 'TIERED':
      return new TieredRule(policy.tiers ?? []);
  }
}
