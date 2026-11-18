// Thin wrapper over the server secret store. Values pass through pipes only; nothing is printed.
import { spawnSync } from "node:child_process";

const STACK = "qorechain";

export function secretNames(): string[] {
  const r = spawnSync("sudo", ["lechu-secret", "keys", STACK], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`lechu-secret keys failed: ${r.stderr.trim()}`);
  return r.stdout.match(/[A-Z0-9_]{3,}/g) ?? [];
}

export function readSecret(key: string): string {
  const r = spawnSync("sudo", ["lechu-secret", "show", STACK, key], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`lechu-secret show ${key} failed`);
  return r.stdout.trim();
}

export function writeSecret(key: string, value: string): void {
  const r = spawnSync("sudo", ["lechu-secret", "set", STACK, key], { input: value, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`lechu-secret set ${key} failed: ${r.stderr.trim()}`);
}
