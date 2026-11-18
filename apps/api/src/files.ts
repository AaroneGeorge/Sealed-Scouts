import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

export interface FileHit { body: Buffer; type: string; mtimeMs: number }

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Reads `rel` under `dir`, refusing any path that would escape `dir`. Missing files return undefined. */
export async function readUnder(dir: string, rel: string): Promise<FileHit | undefined> {
  const full = normalize(join(dir, rel));
  if (full !== dir && !full.startsWith(dir + sep)) return undefined;
  try {
    const s = await stat(full);
    if (!s.isFile()) return undefined;
    return { body: await readFile(full), type: TYPES[extname(full)] ?? "application/octet-stream", mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Public feed files: the watchtower's status and one file per round. Names are fixed patterns, nothing else. */
export function feedFile(name: string): string | undefined {
  if (name === "status.json") return name;
  const m = /^rounds\/(\d{1,20})\.json$/.exec(name);
  return m ? `rounds/${m[1]}.json` : undefined;
}

/** Evidence files written by the attack scripts, one per run (for example `stolen-keys.dry-run.json`). */
export function evidenceFile(name: string): string | undefined {
  return /^[a-z0-9][a-z0-9.-]{0,80}\.json$/.test(name) && !name.includes("..") ? name : undefined;
}

/** The evidence files present, so the page can list runs without knowing their names. */
export async function listEvidence(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n !== "index.json" && evidenceFile(n)).sort();
  } catch {
    return [];
  }
}
