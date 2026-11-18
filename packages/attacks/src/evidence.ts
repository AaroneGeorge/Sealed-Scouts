// Every attack step ends in one line: what was tried, where, and whether it was refused, with the evidence
// (a chain code, a revert name, a tx hash, a rejection reason). Saved as JSON for PROOF.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Where = "chain" | "rollup" | "evm" | "local check" | "simulation";
export interface Step {
  attack: string;
  step: string;
  /**
   * REFUSED: stopped by the defence the step is about (the expected refusal, nothing else). NOT REFUSED: it got
   * through. ERROR: it failed for some other reason, so it proves nothing. ACCEPTED: an expected setup step.
   */
  verdict: "REFUSED" | "NOT REFUSED" | "ERROR" | "ACCEPTED";
  where: Where;
  evidence: Record<string, string | number | boolean>;
  /** The PROOF.md claim this step proves (ids in apps/api/scripts/proof.ts), with the evidence key holding its tx. */
  claim?: { id: string; layer: "native" | "evm"; txKey: string };
}

export const EVIDENCE_DIR = new URL("../evidence", import.meta.url).pathname;
export const CLAIMS_PATH = new URL("../../../evidence/claims.json", import.meta.url).pathname;

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

/**
 * Live runs only: add each refused step that names a claim and recorded a tx to evidence/claims.json
 * ({ claims: { <id>: { tx, layer, note, at } } }), keeping every other claim as it is. Returns the ids written.
 */
export function recordClaims(steps: Step[], path = CLAIMS_PATH): string[] {
  const proven = steps.filter((s) => s.verdict === "REFUSED" && s.claim && typeof s.evidence[s.claim.txKey] === "string" && s.evidence[s.claim.txKey]);
  if (proven.length === 0) return [];
  const file: { claims: Record<string, unknown> } = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { claims: {} };
  file.claims ??= {};
  for (const s of proven) {
    file.claims[s.claim!.id] = { tx: String(s.evidence[s.claim!.txKey]), layer: s.claim!.layer, note: `${s.attack}: ${s.step}`, at: new Date().toISOString() };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 1) + "\n");
  return proven.map((s) => s.claim!.id);
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
