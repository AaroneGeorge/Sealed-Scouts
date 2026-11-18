// Polite HTTP for public price APIs: a fixed User-Agent, a timeout, spacing per host, and retries with
// full-jitter exponential backoff on 429, 5xx and network errors (the pattern from the AWS Builders' Library
// note "Timeouts, retries and backoff with jitter"). A failed read throws; callers never turn it into a zero.

export const USER_AGENT = "sealed-scouts/0.1";

export type GetJson = (url: string) => Promise<unknown>;

export interface PoliteOptions {
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  /** Least time between two requests to the same host. */
  spacingMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class HttpError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`${new URL(url).host} answered HTTP ${status}`);
  }
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

export function politeGetJson(opts: PoliteOptions = {}): GetJson {
  const { timeoutMs = 8_000, retries = 2, baseDelayMs = 400, spacingMs = 250 } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const nextSlot = new Map<string, number>();

  // Reserve the host's next free slot before waiting, so parallel callers queue up instead of bursting.
  async function waitTurn(host: string): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, nextSlot.get(host) ?? 0);
    nextSlot.set(host, at + spacingMs);
    if (at > now) await sleep(at - now);
  }

  return async function getJson(url: string): Promise<unknown> {
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      await waitTurn(host);
      let error: Error;
      try {
        const res = await doFetch(url, {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return await res.json();
        error = new HttpError(url, res.status);
        if (!RETRYABLE(res.status)) throw error;
      } catch (e) {
        if (e instanceof HttpError && !RETRYABLE(e.status)) throw e;
        error = e instanceof Error ? e : new Error(String(e));
      }
      if (attempt >= retries) throw error;
      await sleep(Math.floor(random() * baseDelayMs * 2 ** attempt));
    }
  };
}
