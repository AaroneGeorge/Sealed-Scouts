/** A bounded TTL cache that also merges concurrent misses for the same key into one upstream call. */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expires: number }>();
  private inflight = new Map<string, Promise<V>>();

  constructor(private maxEntries = 500, private now: () => number = Date.now) {}

  get size(): number {
    return this.store.size;
  }

  async getOrLoad(key: string, ttlMs: number, load: () => Promise<V>): Promise<{ value: V; hit: boolean }> {
    const hit = this.store.get(key);
    if (hit && hit.expires > this.now()) return { value: hit.value, hit: true };
    const pending = this.inflight.get(key);
    if (pending) return { value: await pending, hit: true };
    const p = load().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    const value = await p;
    this.set(key, value, ttlMs);
    return { value, hit: false };
  }

  private set(key: string, value: V, ttlMs: number): void {
    this.store.delete(key);
    this.store.set(key, { value, expires: this.now() + ttlMs });
    // Map keeps insertion order, so the first key is the oldest write.
    while (this.store.size > this.maxEntries) this.store.delete(this.store.keys().next().value as string);
  }
}
