// Where the scripts get secrets. Values pass through env vars and pipes only; nothing is printed.
// - Reading: the env var of that name (e.g. SS_OPERATOR_MNEMONIC) wins.
// - Otherwise, and for storing: the command in SS_SECRET_CMD (no default), called as
//     $SS_SECRET_CMD get KEY      prints the value
//     $SS_SECRET_CMD set KEY      reads the value on stdin
//     $SS_SECRET_CMD list         prints the stored names
//   Point it at a small local script for your own secret store (keep that script out of git).
import { spawnSync } from "node:child_process";

function secretCmd(action: string, key?: string, input?: string): string {
  const cmd = process.env.SS_SECRET_CMD;
  if (!cmd) throw new Error("SS_SECRET_CMD is not set: export the SS_*_MNEMONIC env vars, or set SS_SECRET_CMD to your secret store command");
  const args = key ? [action, key] : [action];
  // Through sh so SS_SECRET_CMD may carry its own arguments.
  const r = spawnSync("sh", ["-c", `${cmd} "$@"`, "sh", ...args], { input, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`secret command "${action}${key ? ` ${key}` : ""}" failed (exit ${r.status})`);
  return r.stdout;
}

/** Names known to the env or the secret store. */
export function secretNames(): string[] {
  const fromEnv = Object.keys(process.env).filter((k) => /^SS_[A-Z0-9_]+_MNEMONIC$/.test(k));
  const fromStore = process.env.SS_SECRET_CMD ? (secretCmd("list").match(/[A-Z0-9_]{3,}/g) ?? []) : [];
  return [...new Set([...fromEnv, ...fromStore])];
}

/** The env var, or the store. `fromStore` skips the env (to check what was really stored). */
export function readSecret(key: string, opts: { fromStore?: boolean } = {}): string {
  const env = process.env[key];
  if (env && !opts.fromStore) return env.trim();
  return secretCmd("get", key).trim();
}

export function writeSecret(key: string, value: string): void {
  secretCmd("set", key, value);
}
