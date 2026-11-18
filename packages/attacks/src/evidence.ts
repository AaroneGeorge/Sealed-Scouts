// Every attack step ends in one line: what was tried, where, and whether it was refused, with the evidence
// (a chain code, a revert name, a tx hash, a rejection reason). Saved as JSON for PROOF.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Where = "chain" | "rollup" | "evm" | "local check" | "simulation";
export interface Step {
  attack: string;
  step: string;
  /** REFUSED: the attack did not get through. ACCEPTED: an expected, harmless acceptance (a setup step). */
  verdict: "REFUSED" | "NOT REFUSED" | "ACCEPTED";
  where: Where;
  evidence: Record<string, string | number | boolean>;
}

export const EVIDENCE_DIR = new URL("../evidence", import.meta.url).pathname;

export function printSteps(steps: Step[]): void {
  for (const s of steps) {
    const ev = Object.entries(s.evidence).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`${s.verdict.padEnd(11)} [${s.where}] ${s.attack}: ${s.step}${ev ? `  (${ev})` : ""}`);
  }
}

export function saveEvidence(name: string, steps: Step[], dryRun: boolean, dir = EVIDENCE_DIR): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}${dryRun ? ".dry-run" : ""}.json`);
  const note = dryRun ? "DRY RUN: local checks and an in-memory simulation, no chain transactions." : "Live testnet run (qorechain-diana).";
  writeFileSync(path, JSON.stringify({ name, note, at: new Date().toISOString(), steps }, null, 1) + "\n");
  return path;
}

/** Text of an error, with a viem revert's name when there is one. */
export function errorEvidence(e: unknown): Record<string, string> {
  const err = e as { walk?: (fn: (x: unknown) => boolean) => unknown; shortMessage?: string; message?: string };
  const reverted = err.walk?.((x) => (x as { name?: string }).name === "ContractFunctionRevertedError") as
    | { data?: { errorName?: string }; reason?: string }
    | undefined;
  const name = reverted?.data?.errorName ?? reverted?.reason;
  return { ...(name ? { revert: name } : {}), error: (err.shortMessage ?? err.message ?? String(e)).split("\n")[0]!.slice(0, 200) };
}
