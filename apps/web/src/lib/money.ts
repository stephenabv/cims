/**
 * Peso amounts are integer centavos everywhere. These helpers only convert at the edges (what
 * people type and read); arithmetic stays on integers.
 */

/** 123450 → "₱1,234.50". */
export function formatPeso(centavos: number): string {
  const sign = centavos < 0 ? '−' : '';
  const a = Math.abs(centavos);
  const pesos = Math.floor(a / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}₱${pesos}.${String(a % 100).padStart(2, '0')}`;
}

/** "1,234.5", "₱1234.50" or "1234" → 123450; null when it is not a plain peso amount. */
export function parsePeso(text: string): number | null {
  const t = text.trim().replace(/^₱/, '').replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** 123450 → "1234.50", for pre-filling inputs. */
export const pesoInput = (centavos: number): string =>
  `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, '0')}`;

/** Basis points ↔ "4.5" percent text. */
export function parsePercent(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/%$/, ''));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
export const formatPercent = (bp: number): string =>
  `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** Multiplier per mille ↔ "1.25". */
export function parseMultiplier(text: string): number | null {
  const m = /^(\d)(?:\.(\d{1,3}))?$/.exec(text.trim().replace(/×$/, ''));
  if (!m) return null;
  return Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
}
export const formatMultiplier = (permille: number): string =>
  `${(permille / 1000).toFixed(3).replace(/\.?0+$/, '')}×`;
