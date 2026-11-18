import { describe, expect, it } from "vitest";
import { HttpError, politeGetJson, USER_AGENT } from "../src/prices/http.js";

function fakeFetch(statuses: number[]) {
  const seen: { url: string; ua: string | undefined; hasSignal: boolean }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({ url, ua: (init.headers as Record<string, string>)["user-agent"], hasSignal: init.signal instanceof AbortSignal });
    const status = statuses[Math.min(seen.length - 1, statuses.length - 1)]!;
    return new Response(JSON.stringify({ ok: status }), { status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("politeGetJson", () => {
  const sleeps: number[] = [];
  const opts = { sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5, spacingMs: 0 };

  it("sends the project User-Agent and a timeout", async () => {
    const f = fakeFetch([200]);
    expect(await politeGetJson({ ...opts, fetchImpl: f.impl })("https://x.test/a")).toEqual({ ok: 200 });
    expect(f.seen[0]).toMatchObject({ ua: USER_AGENT, hasSignal: true });
  });

  it("backs off and retries on 429 and 5xx", async () => {
    sleeps.length = 0;
    const f = fakeFetch([429, 503, 200]);
    expect(await politeGetJson({ ...opts, fetchImpl: f.impl, baseDelayMs: 100 })("https://x.test/a")).toEqual({ ok: 200 });
    expect(f.seen).toHaveLength(3);
    expect(sleeps).toEqual([50, 100]);
  });

  it("gives up after the retry budget and throws, never returning a value", async () => {
    const f = fakeFetch([503]);
    await expect(politeGetJson({ ...opts, fetchImpl: f.impl, retries: 1 })("https://x.test/a")).rejects.toBeInstanceOf(HttpError);
    expect(f.seen).toHaveLength(2);
  });

  it("does not retry a 4xx other than 429", async () => {
    const f = fakeFetch([404]);
    await expect(politeGetJson({ ...opts, fetchImpl: f.impl })("https://x.test/a")).rejects.toThrow(/404/);
    expect(f.seen).toHaveLength(1);
  });
});
