// Median and band rules (docs/SPEC.md). Integer math only, so every implementation agrees.

/** Lower median: element floor((n-1)/2) of the ascending list. Throws on an empty list. */
export function median(values: bigint[]): bigint {
  if (values.length === 0) throw new RangeError("median of an empty list");
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor((values.length - 1) / 2)]!;
}

/** |price - median| * 10000 <= bps * median. */
export function withinBps(price: bigint, med: bigint, bps: number): boolean {
  const diff = price > med ? price - med : med - price;
  return diff * 10_000n <= BigInt(bps) * med;
}

/** In band: within BAND_BPS of the median (inclusive). Earns rewards. */
export const isInBand = (price: bigint, med: bigint, bandBps: number): boolean => withinBps(price, med, bandBps);
/** Outlier: strictly beyond SLASH_BPS from the median. Slashable. */
export const isOutlier = (price: bigint, med: bigint, slashBps: number): boolean => !withinBps(price, med, slashBps);
