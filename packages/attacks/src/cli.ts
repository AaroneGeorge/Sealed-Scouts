// Attack scripts that produce the demo evidence. Each prints one line per step, REFUSED or NOT REFUSED, and saves
// the evidence to packages/attacks/evidence/<attack>[.dry-run].json.
//   npm run demo:stolen-keys [-- --dry-run]
//   npm run demo:evil-median [-- --dry-run]   live: needs the operator's lie switch for one round
//   npm run demo:bad-batch   [-- --dry-run] [-- --bond]   live: ROGUE locks (and loses) a 1,000 QOR bond
//   npm run redteam          [-- --dry-run]
// Live runs take --demo (or SS_DEMO=1) when the operator runs demo rounds, so they cut rounds the same way.
import { parseArgs } from "node:util";
import { demoFromEnv } from "@sealed-scouts/scout";
import { badBatchDryRun, badBatchLive } from "./bad-batch.js";
import { evilMedianDryRun, evilMedianLive } from "./evil-median.js";
import { printSteps, recordClaims, saveEvidence, type Step } from "./evidence.js";
import { stolenKeysDryRun, stolenKeysLive } from "./stolen-keys.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false }, bond: { type: "boolean", default: false }, "timeout-min": { type: "string", default: "30" },
    demo: { type: "boolean", default: demoFromEnv() },
  },
});
const dry = values["dry-run"]!;

const ATTACKS: Record<string, () => Promise<Step[]>> = {
  "stolen-keys": () => (dry ? stolenKeysDryRun() : stolenKeysLive({ demo: values.demo })),
  "evil-median": () => (dry ? evilMedianDryRun() : evilMedianLive({ timeoutMs: Number(values["timeout-min"]) * 60_000, demo: values.demo })),
  "bad-batch": () => (dry ? badBatchDryRun() : badBatchLive({ bond: values.bond, demo: values.demo })),
};

const name = positionals[0] ?? "";
const run = name === "redteam" ? Object.keys(ATTACKS) : [name];
if (!run.every((n) => ATTACKS[n])) throw new Error(`unknown attack "${name}" (${Object.keys(ATTACKS).join(", ")}, redteam)`);
if (dry) console.log("DRY RUN: local checks and an in-memory simulation. No transaction is sent.\n");

const all: Step[] = [];
for (const n of run) {
  try {
    const steps = await ATTACKS[n]!();
    printSteps(steps);
    console.log(`  evidence: ${saveEvidence(n, steps, dry)}`);
    const claims = dry ? [] : recordClaims(steps);
    console.log(claims.length ? `  claims.json: ${claims.join(", ")}\n` : "");
    all.push(...steps);
  } catch (e) {
    console.log(`ERROR       ${n}: ${(e as Error).message}\n`);
    all.push({ attack: n, step: "run", verdict: "NOT REFUSED", where: dry ? "simulation" : "chain", evidence: { error: (e as Error).message } });
  }
}
const attempts = all.filter((s) => s.verdict !== "ACCEPTED");
const through = attempts.filter((s) => s.verdict !== "REFUSED");
if (name === "redteam") {
  console.log(`redteam: ${attempts.length - through.length} of ${attempts.length} attack steps REFUSED`);
  saveEvidence("redteam", all, dry);
}
process.exit(through.length === 0 ? 0 : 1);
