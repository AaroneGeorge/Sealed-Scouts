import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname } from "node:path";
import { TtlCache } from "./cache.js";
import type { Config } from "./config.js";
import { evidenceFile, feedFile, listEvidence, readUnder } from "./files.js";
import { RateLimiter } from "./ratelimit.js";
import { Upstream, type UpstreamResponse } from "./upstream.js";
import { allow } from "./whitelist.js";

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  // The page talks to its own origin and, for "Verify on chain", straight to the public EVM endpoint.
  "content-security-policy":
    "default-src 'self'; connect-src 'self' https://evm-testnet.qore.host; img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export interface AppDeps { upstream?: Upstream; now?: () => number }

/** The whole HTTP surface. Read-only: GET and HEAD only, no keys, no writes. */
export function createApp(cfg: Config, deps: AppDeps = {}) {
  const upstream = deps.upstream ?? new Upstream(cfg.restUrl);
  const cache = new TtlCache<UpstreamResponse>(500, deps.now);
  const limiter = new RateLimiter(cfg.ratePerMin, deps.now);
  const started = Date.now();
  let lastUpstreamOk = 0;

  const send = (res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, ...extra });
    res.end(res.req.method === "HEAD" ? undefined : body);
  };
  const json = (res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) =>
    send(res, status, JSON.stringify(value), "application/json; charset=utf-8", extra);

  const clientKey = (req: IncomingMessage) => {
    const fwd = req.headers["x-forwarded-for"];
    if (cfg.trustProxy && typeof fwd === "string" && fwd) return fwd.split(",")[0]!.trim();
    return req.socket.remoteAddress ?? "unknown";
  };

  async function chain(res: ServerResponse, path: string, search: URLSearchParams) {
    const ok = allow(path, search);
    if (!ok) return json(res, 403, { error: "this read is not on the proxy's list" });
    try {
      const { value, hit } = await cache.getOrLoad(ok.upstreamPath, ok.ttlMs, async () => {
        const r = await upstream.get(ok.upstreamPath);
        // Cache only answers we would repeat: successes and clean 404s. Errors go to the next caller again.
        if (r.status !== 200 && r.status !== 404) throw Object.assign(new Error(`upstream status ${r.status}`), { upstream: r });
        return r;
      });
      if (value.status === 200) lastUpstreamOk = Date.now();
      return send(res, value.status, value.body, "application/json; charset=utf-8", {
        "cache-control": `public, max-age=${Math.floor(ok.ttlMs / 1000)}`,
        "x-cache": hit ? "hit" : "miss",
        "access-control-allow-origin": "*",
      });
    } catch (e) {
      const up = (e as { upstream?: UpstreamResponse }).upstream;
      return json(res, 502, { error: "upstream read failed", status: up?.status ?? null, detail: (e as Error).message });
    }
  }

  async function file(res: ServerResponse, dir: string, rel: string | undefined, maxAge: number) {
    const hit = rel ? await readUnder(dir, rel) : undefined;
    if (!hit) return json(res, 404, { error: "not found" });
    return send(res, 200, hit.body, hit.type, {
      "cache-control": `public, max-age=${maxAge}`,
      "last-modified": new Date(hit.mtimeMs).toUTCString(),
      "access-control-allow-origin": "*",
    });
  }

  async function health(res: ServerResponse) {
    const status = await readUnder(cfg.feedDir, "status.json");
    return json(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - started) / 1000),
      cacheEntries: cache.size,
      lastUpstreamOk: lastUpstreamOk ? new Date(lastUpstreamOk).toISOString() : null,
      feed: status ? { present: true, ageSec: Math.round((Date.now() - status.mtimeMs) / 1000) } : { present: false },
    });
  }

  async function web(res: ServerResponse, path: string) {
    const rel = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
    const hit = (await readUnder(cfg.webDist, rel)) ?? (extnameless(rel) ? await readUnder(cfg.webDist, "index.html") : undefined);
    if (!hit) return json(res, 404, { error: "not found" });
    const immutable = rel.startsWith("assets/");
    return send(res, 200, hit.body, hit.type, { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "read-only" }, { allow: "GET, HEAD" });
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://local");
    } catch {
      return json(res, 400, { error: "bad url" });
    }
    const path = url.pathname;
    if (path === "/health") return health(res);
    if (path.startsWith("/api/") && !limiter.take(clientKey(req))) {
      return json(res, 429, { error: "slow down" }, { "retry-after": "10" });
    }
    if (path.startsWith("/api/chain/")) return chain(res, path.slice("/api/chain".length), url.searchParams);
    if (path.startsWith("/api/feed/")) return file(res, cfg.feedDir, feedFile(path.slice("/api/feed/".length)), 5);
    if (path === "/api/evidence/index.json") return json(res, 200, { files: await listEvidence(cfg.evidenceDir) }, { "cache-control": "public, max-age=30" });
    if (path.startsWith("/api/evidence/")) return file(res, cfg.evidenceDir, evidenceFile(path.slice("/api/evidence/".length)), 30);
    if (path === "/api/deployments") return file(res, dirname(cfg.deploymentsFile), basename(cfg.deploymentsFile), 30);
    if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });
    return web(res, path);
  };
}

/** Paths without a file extension are page routes; they get the app shell. */
const extnameless = (rel: string) => !/\.[a-z0-9]+$/i.test(rel);
