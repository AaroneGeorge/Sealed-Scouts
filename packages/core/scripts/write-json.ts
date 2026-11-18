import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonify } from "../src/index.js";

/** repo/fixtures */
export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

export function writeJson(rel: string, value: unknown): string {
  const path = resolve(FIXTURES_DIR, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(jsonify(value), null, 2) + "\n");
  return path;
}
