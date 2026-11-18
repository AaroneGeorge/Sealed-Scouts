export const USER_AGENT = "sealed-scouts/0.1";

export interface UpstreamResponse { status: number; body: string }

export class UpstreamError extends Error {}

/**
 * Polite reads from the public QoreChain REST endpoint: one shared spacing gap between calls, a timeout, and one
 * retry with backoff on 429 or a network error. A failed read is reported as an error, never turned into data.
 */
export class Upstream {
  private nextSlot = 0;

  constructor(
    private baseUrl: string,
    private opts: { spacingMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ) {}

  async get(path: string): Promise<UpstreamResponse> {
    for (let attempt = 0; ; attempt++) {
      await this.waitForSlot();
      let res: Response;
      try {
        res = await (this.opts.fetchImpl ?? fetch)(this.baseUrl + path, {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
        });
      } catch (e) {
        if (attempt === 0) {
          await sleep(1000);
          continue;
        }
        throw new UpstreamError(`upstream unreachable: ${(e as Error).message}`);
      }
      if (res.status === 429 && attempt === 0) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 1500);
        continue;
      }
      return { status: res.status, body: await res.text() };
    }
  }

  private async waitForSlot(): Promise<void> {
    const t = Date.now();
    const wait = Math.max(0, this.nextSlot - t);
    this.nextSlot = Math.max(t, this.nextSlot) + (this.opts.spacingMs ?? 100);
    if (wait > 0) await sleep(wait);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
