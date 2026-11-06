/**
 * Integer money arithmetic. Amounts are centavos; every intermediate value must stay a safe
 * integer so results are exact and identical on every run (no floating point, ever).
 */

function assertSafe(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} is not a safe integer: ${n}`);
}

/** n ÷ d rounded half away from zero (₱0.005 → ₱0.01), for integers. */
export function divRound(n: number, d: number): number {
  assertSafe(n, 'numerator');
  assertSafe(d, 'denominator');
  if (d <= 0) throw new RangeError('denominator must be positive');
  const sign = n < 0 ? -1 : 1;
  const a = Math.abs(n);
  const q = Math.floor(a / d);
  const r = a - q * d;
  return sign * (r * 2 >= d ? q + 1 : q);
}

/** minutes × (centavos per hour) ÷ 60, rounded to the centavo. */
export function payForMinutes(minutes: number, hourlyCentavos: number): number {
  return divRound(minutes * hourlyCentavos, 60);
}

/** "₱1,234.50" — for breakdown text only; amounts themselves stay integers. */
export function formatPeso(centavos: number): string {
  const sign = centavos < 0 ? '−' : '';
  const a = Math.abs(centavos);
  const pesos = Math.floor(a / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}₱${pesos}.${String(a % 100).padStart(2, '0')}`;
}

/** 90 → "1h 30m". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}
