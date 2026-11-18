/** Token bucket per client key: `perMin` requests a minute, bursts up to the same number. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private perMin: number, private now: () => number = Date.now) {}

  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMin, at: t };
    b.tokens = Math.min(this.perMin, b.tokens + ((t - b.at) / 60_000) * this.perMin);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.prune(t);
    return ok;
  }

  /** Full buckets carry no state worth keeping. */
  private prune(t: number): void {
    for (const [k, b] of this.buckets) if (b.tokens + ((t - b.at) / 60_000) * this.perMin >= this.perMin) this.buckets.delete(k);
  }
}
