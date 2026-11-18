import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { TtlCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { RateLimiter } from "../src/ratelimit.js";
import { Upstream } from "../src/upstream.js";
import { allow } from "../src/whitelist.js";

describe("whitelist", () => {
  const q = (s = "") => new URLSearchParams(s);
  it("allows the reads the page needs", () => {
    for (const p of [
      "/qorechain/rdk/v1/rollup/sealed-scouts-1", "/qorechain/rdk/v1/batch/vigil-1/28", "/qorechain/rdk/v1/latest_batch/vigil-1",
      "/qorechain/multilayer/v1/anchors/vigil-1", "/qorechain/pqc/v1/account/qor107qxkklc0znm38tl0595asa9z73c69w85tsztr",
      "/qorechain/pqc/v1/kem/qor107qxkklc0znm38tl0595asa9z73c69w85tsztr", "/qorechain/rdk/v1/params",
    ]) expect(allow(p, q()), p).toBeDefined();
  });
  it("refuses everything else", () => {
    for (const p of [
      "/cosmos/bank/v1beta1/balances/qor1abc", "/qorechain/rdk/v1/rollup/../params", "/qorechain/rdk/v1/rollup/A_B",
      "/qorechain/rdk/v1/batch/vigil-1/x", "/", "/qorechain/rdk/v1/rollup/vigil-1/extra",
    ]) expect(allow(p, q()), p).toBeUndefined();
  });
  it("keeps only allowed query keys, in a fixed order", () => {
    expect(allow("/qorechain/rdk/v1/batches/vigil-1", q("limit=5&evil=1&start_index=3"))?.upstreamPath)
      .toBe("/qorechain/rdk/v1/batches/vigil-1?limit=5&start_index=3");
    expect(allow("/qorechain/rdk/v1/rollup/vigil-1", q("x=1"))?.upstreamPath).toBe("/qorechain/rdk/v1/rollup/vigil-1");
  });
});

describe("TtlCache", () => {
  it("merges concurrent misses and expires entries", async () => {
    let t = 0, calls = 0;
    const c = new TtlCache<number>(10, () => t);
    const load = async () => ++calls;
    const [a, b] = await Promise.all([c.getOrLoad("k", 100, load), c.getOrLoad("k", 100, load)]);
    expect([a.value, b.value, calls]).toEqual([1, 1, 1]);
    expect((await c.getOrLoad("k", 100, load)).hit).toBe(true);
    t = 101;
    expect((await c.getOrLoad("k", 100, load)).value).toBe(2);
  });
  it("evicts the oldest entry past its size", async () => {
    const c = new TtlCache<string>(2);
    for (const k of ["a", "b", "c"]) await c.getOrLoad(k, 1000, async () => k);
    expect(c.size).toBe(2);
  });
  it("does not cache a failed load", async () => {
    const c = new TtlCache<string>();
    await expect(c.getOrLoad("k", 1000, async () => { throw new Error("down"); })).rejects.toThrow("down");
    expect((await c.getOrLoad("k", 1000, async () => "ok")).value).toBe("ok");
  });
});

describe("RateLimiter", () => {
  it("allows a burst, then refills over time", () => {
    let t = 0;
    const r = new RateLimiter(3, () => t);
    expect([r.take("ip"), r.take("ip"), r.take("ip"), r.take("ip")]).toEqual([true, true, true, false]);
    expect(r.take("other")).toBe(true);
    t = 20_000;
    expect(r.take("ip")).toBe(true);
  });
});

describe("Upstream", () => {
  it("retries once on 429 and sends our user agent", async () => {
    const seen: string[] = [];
    let n = 0;
    const up = new Upstream("https://x", { spacingMs: 0, fetchImpl: (async (_u: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)["user-agent"]!);
      return ++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response("{}", { status: 200 });
    }) as typeof fetch });
    expect((await up.get("/p")).status).toBe(200);
    expect(seen).toEqual(["sealed-scouts/0.1", "sealed-scouts/0.1"]);
  });
});

describe("HTTP app", () => {
  let server: Server, base: string, upstreamCalls = 0, upstreamStatus = 200;
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "ss-api-"));
    await mkdir(join(dir, "feed/rounds"), { recursive: true });
    await mkdir(join(dir, "evidence"));
    await mkdir(join(dir, "web"));
    await writeFile(join(dir, "feed/status.json"), '{"version":1}');
    await writeFile(join(dir, "feed/rounds/7.json"), '{"round":"7"}');
    await writeFile(join(dir, "evidence/attacks.json"), '{"attacks":[]}');
    await writeFile(join(dir, "secret.json"), '{"no":1}');
    await writeFile(join(dir, "web/index.html"), "<!doctype html><title>t</title>");
    const cfg = { ...loadConfig({}), feedDir: join(dir, "feed"), evidenceDir: join(dir, "evidence"),
      deploymentsFile: join(dir, "missing.json"), webDist: join(dir, "web"), ratePerMin: 1000 };
    const upstream = { get: async () => { upstreamCalls++; return { status: upstreamStatus, body: '{"rollup":{}}' }; } } as unknown as Upstream;
    const handle = createApp(cfg, { upstream });
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const get = (p: string, init?: RequestInit) => fetch(base + p, init);

  it("serves the feed and evidence files", async () => {
    expect(await (await get("/api/feed/status.json")).json()).toEqual({ version: 1 });
    expect(await (await get("/api/feed/rounds/7.json")).json()).toEqual({ round: "7" });
    expect((await get("/api/evidence/attacks.json")).status).toBe(200);
    expect(await (await get("/api/evidence/index.json")).json()).toEqual({ files: ["attacks.json"] });
  });
  it("refuses paths outside the feed", async () => {
    for (const p of ["/api/feed/../secret.json", "/api/feed/rounds/..%2f..%2fsecret.json", "/api/evidence/..%2fsecret.json", "/api/feed/other.json"]) {
      expect((await get(p)).status, p).toBe(404);
    }
  });
  it("is read-only", async () => {
    expect((await get("/api/feed/status.json", { method: "POST" })).status).toBe(405);
  });
  it("proxies whitelisted reads once, then from cache", async () => {
    upstreamCalls = 0;
    const a = await get("/api/chain/qorechain/rdk/v1/rollup/vigil-1");
    const b = await get("/api/chain/qorechain/rdk/v1/rollup/vigil-1");
    expect([a.status, a.headers.get("x-cache"), b.headers.get("x-cache"), upstreamCalls]).toEqual([200, "miss", "hit", 1]);
    expect(a.headers.get("access-control-allow-origin")).toBe("*");
  });
  it("refuses reads that are not on the list", async () => {
    expect((await get("/api/chain/cosmos/bank/v1beta1/balances/qor1x")).status).toBe(403);
  });
  it("turns upstream errors into 502 and does not cache them", async () => {
    upstreamStatus = 500;
    upstreamCalls = 0;
    expect((await get("/api/chain/qorechain/rdk/v1/rollup/other-1")).status).toBe(502);
    expect((await get("/api/chain/qorechain/rdk/v1/rollup/other-1")).status).toBe(502);
    expect(upstreamCalls).toBe(2);
    upstreamStatus = 200;
  });
  it("answers 404 for missing deployments and serves the page shell", async () => {
    expect((await get("/api/deployments")).status).toBe(404);
    const page = await get("/round/7");
    expect([page.status, page.headers.get("content-security-policy")?.includes("default-src 'self'")]).toEqual([200, true]);
  });
  it("reports health", async () => {
    const h = await (await get("/health")).json();
    expect(h).toMatchObject({ ok: true, feed: { present: true } });
  });
});

describe("rate limit on /api", () => {
  it("answers 429 past the limit", async () => {
    const cfg = { ...loadConfig({}), ratePerMin: 2, feedDir: "/nonexistent" };
    const handle = createApp(cfg, { upstream: {} as Upstream });
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/feed/status.json`;
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(url)).status);
    await new Promise<void>((r) => server.close(() => r()));
    expect(codes).toEqual([404, 404, 429]);
  });
});
