// Polite HTTP for shared public endpoints: a clear User-Agent, a minimum gap between requests to the
// same host, and exponential backoff with full jitter on 429, 5xx and network errors. A 429 with Retry-After
// (the testnet's tx search answers "retry-after: 59") waits at least that long, up to maxRetryAfterMs.
// Retry rule from "Exponential backoff and jitter" (AWS architecture blog).

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /** Present on real responses; read for Retry-After. */
  headers?: { get(name: string): string | null };
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export interface PoliteOptions {
  userAgent: string;
  /** Smallest gap between two requests to one host, in ms. */
  spacingMs?: number;
  /** Attempts in total, the first included. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Longest Retry-After honoured, in ms. */
  maxRetryAfterMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function politeFetch(opts: PoliteOptions): FetchLike {
  const base = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const spacing = opts.spacingMs ?? 150;
  const attempts = opts.attempts ?? 6;
  const baseDelay = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 20_000;
  const maxRetryAfter = opts.maxRetryAfterMs ?? 120_000;
  // Next free slot per host; requests reserve a slot before they wait, so concurrent callers queue up.
  const nextSlot = new Map<string, number>();

  async function waitTurn(host: string): Promise<void> {
    const t = now();
    const slot = Math.max(t, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + spacing);
    if (slot > t) await sleep(slot - t);
  }

  return async (url, init = {}) => {
    const host = new URL(url).host;
    const headers = { "user-agent": opts.userAgent, accept: "application/json", ...(init.headers ?? {}) };
    let lastError: unknown;
    let retryAfter = 0;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(Math.max(retryAfter, Math.floor(random() * Math.min(maxDelay, baseDelay * 2 ** attempt))));
      retryAfter = 0;
      await waitTurn(host);
      try {
        const res = await base(url, { ...init, headers });
        if (!RETRY_STATUS.has(res.status)) return res;
        lastError = new Error(`HTTP ${res.status} from ${host}`);
        const seconds = Number(res.headers?.get("retry-after") ?? "");
        if (res.status === 429 && Number.isFinite(seconds) && seconds > 0) retryAfter = Math.min(seconds * 1000, maxRetryAfter);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`${init.method ?? "GET"} ${url} failed after ${attempts} attempts: ${errorText(lastError)}`);
  };
}

/** GET or POST JSON; any non-2xx answer is an error, never an empty value. */
export async function getJson<T>(fetch: FetchLike, url: string, body?: unknown): Promise<T> {
  const res = await fetch(
    url,
    body === undefined
      ? undefined
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${url}: ${(await safeText(res)).slice(0, 300)}`, res.status);
  return (await res.json()) as T;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function safeText(res: HttpResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
