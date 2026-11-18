import type { AttackRun, Deployments, TowerRound, TowerStatus } from "./types";

/** Same origin by default: the API server also serves this page. VITE_API_BASE points elsewhere if needed. */
const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");

export class NotFound extends Error {}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: { accept: "application/json" } });
  if (res.status === 404) throw new NotFound(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  status: () => getJson<TowerStatus>("/api/feed/status.json"),
  round: (n: string) => getJson<TowerRound>(`/api/feed/rounds/${encodeURIComponent(n)}.json`),
  /** Every recorded attack run, newest first. */
  attacks: async () => {
    const { files } = await getJson<{ files: string[] }>("/api/evidence/index.json");
    const runs = await Promise.all(files.map((f) => getJson<AttackRun>(`/api/evidence/${encodeURIComponent(f)}`)));
    return runs.sort((a, b) => b.at.localeCompare(a.at));
  },
  deployments: () => getJson<Deployments>("/api/deployments"),
  /** A whitelisted QoreChain REST read through our proxy (the REST endpoint sends no CORS headers). */
  chain: <T>(path: string) => getJson<T>(`/api/chain${path}`),
};
