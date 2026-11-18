import { describe, expect, it } from "vitest";
import { getJson, politeFetch, type FetchLike, type HttpResponse } from "../src/http.js";

const res = (status: number, body: unknown = {}): HttpResponse => ({
  ok: status < 300,
  status,
  statusText: String(status),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function harness(statuses: (number | Error)[]) {
  const calls: { url: string; ua?: string }[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const base: FetchLike = async (url, init) => {
    calls.push({ url, ua: init?.headers?.["user-agent"] });
    const next = statuses.shift() ?? 200;
    if (next instanceof Error) throw next;
    return res(next, { ok: true });
  };
  const fetch = politeFetch({
    userAgent: "sealed-scouts/0.1",
    fetch: base,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 1,
    attempts: 4,
    baseDelayMs: 100,
    spacingMs: 50,
  });
  return { fetch, calls, sleeps };
}

describe("politeFetch", () => {
  it("sends the User-Agent", async () => {
    const h = harness([200]);
    await h.fetch("https://api.example/x");
    expect(h.calls[0]!.ua).toBe("sealed-scouts/0.1");
  });

  it("backs off on 429 and 503, then succeeds", async () => {
    const h = harness([429, 503, 200]);
    const r = await h.fetch("https://api.example/x");
    expect(r.status).toBe(200);
    expect(h.calls).toHaveLength(3);
    // full jitter with random() = 1: 100 * 2^1, then 100 * 2^2
    expect(h.sleeps.filter((s) => s >= 200)).toEqual([200, 400]);
  });

  it("retries network errors and gives up with an error, never an empty answer", async () => {
    const h = harness([new Error("ECONNRESET"), 429, 429, 429]);
    await expect(h.fetch("https://api.example/x")).rejects.toThrow(/failed after 4 attempts/);
  });

  it("does not retry a 404: that is an answer", async () => {
    const h = harness([404]);
    expect((await h.fetch("https://api.example/x")).status).toBe(404);
    expect(h.calls).toHaveLength(1);
  });

  it("spaces requests to one host", async () => {
    const h = harness([200, 200, 200]);
    await Promise.all([h.fetch("https://a.example/1"), h.fetch("https://a.example/2"), h.fetch("https://a.example/3")]);
    // The fake clock moves on each sleep: calls start at t=0, 50 and 100.
    expect(h.sleeps).toEqual([50, 50]);
  });
});

describe("getJson", () => {
  it("turns a non-2xx answer into an error", async () => {
    const fetch: FetchLike = async () => res(500, { message: "boom" });
    await expect(getJson(fetch, "https://x.example/y")).rejects.toThrow(/HTTP 500/);
  });
});
