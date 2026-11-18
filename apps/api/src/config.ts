import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
/** Repo root, so relative paths in env vars work the same from any working directory. */
export const REPO_ROOT = resolve(here, "../../..");

const fromRoot = (p: string) => resolve(REPO_ROOT, p);
const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export interface Config {
  host: string;
  port: number;
  restUrl: string;
  feedDir: string;
  evidenceDir: string;
  deploymentsFile: string;
  webDist: string;
  /** Requests per minute per client IP. */
  ratePerMin: number;
  /** Behind a proxy that overwrites X-Forwarded-For (our hosting sidecar does), trust its first hop. */
  trustProxy: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: int(env.PORT, 8790),
    restUrl: (env.QORE_REST ?? "https://api-testnet.qore.host").replace(/\/+$/, ""),
    feedDir: fromRoot(env.FEED_DIR ?? "feed"),
    evidenceDir: fromRoot(env.EVIDENCE_DIR ?? "packages/attacks/evidence"),
    deploymentsFile: fromRoot(env.DEPLOYMENTS_FILE ?? "deployments/diana.json"),
    webDist: fromRoot(env.WEB_DIST ?? "apps/web/dist"),
    ratePerMin: int(env.RATE_PER_MIN, 120),
    trustProxy: env.TRUST_PROXY === "1",
  };
}
