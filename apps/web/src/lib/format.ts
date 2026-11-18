const PRICE_DECIMALS = 8;

/** Prices are integers with 8 decimals (docs/SPEC.md). Show 2 decimals, or 4 for values under 10. */
export function formatPrice(raw: string | bigint, decimals = PRICE_DECIMALS): string {
  const v = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const shown = whole < 10n ? 4 : 2;
  const frac = (v % scale).toString().padStart(decimals, "0").slice(0, shown);
  return `${whole.toLocaleString("en-US")}.${frac}`;
}

export const formatInt = (v: string | number | bigint) => BigInt(v).toLocaleString("en-US");

export const shortHash = (h: string, keep = 6) =>
  h.length <= keep * 2 + 3 ? h : `${h.slice(0, keep + (h.startsWith("0x") ? 2 : 0))}…${h.slice(-keep)}`;

export function timeAgo(unixSec: number, now = Date.now() / 1000): string {
  const d = Math.max(0, Math.round(now - unixSec));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/** Distance from the median in basis points, signed. */
export function bpsFrom(price: string, median: string): number {
  const m = BigInt(median);
  if (m === 0n) return 0;
  return Number(((BigInt(price) - m) * 10000n) / m);
}

export const BAND_BPS = 200;
export const SLASH_BPS = 1000;
