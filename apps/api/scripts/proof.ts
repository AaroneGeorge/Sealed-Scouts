/**
 * `npm run proof`: writes PROOF.md from the evidence files, so every README claim points at a transaction or a read
 * anyone can repeat. Claims with no evidence yet are listed as "pending", never filled with a guess.
 *
 * Inputs (all optional): evidence/claims.json (tx hashes per claim id, see CLAIMS) and the attack runs that
 * packages/attacks writes to packages/attacks/evidence/*.json. Dry runs are left out: only live testnet runs count.
 * Shapes: docs/RUNBOOK.md, "Evidence files".
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../src/config.js";

const REST = "https://api-testnet.qore.host";
const EVM = "https://evm-testnet.qore.host";

export interface ClaimEvidence { tx?: string; layer?: "native" | "evm"; note?: string; at?: string }
export interface ProofFile { claims: Record<string, ClaimEvidence> }
export interface AttackStep { attack: string; step: string; verdict: string; where: string; evidence: Record<string, string | number | boolean> }
export interface AttackRun { name: string; note: string; at: string; steps: AttackStep[] }

interface Claim { id: string; req: string; claim: string; check: string }

/** The README's claims, in the order of the fest's requirements. */
export const CLAIMS: Claim[] = [
  { id: "rollup-created", req: "R1", claim: "Rollup `sealed-scouts-1` runs on QoreChain's rollup module: optimistic, `qledger-v1`, based sequencing.", check: `\`curl ${REST}/qorechain/rdk/v1/rollup/sealed-scouts-1\`` },
  { id: "pqc-key-registered", req: "R2", claim: "The operator's ML-DSA-87 key is registered with proof of possession.", check: `\`curl ${REST}/qorechain/pqc/v1/account/<operator qor1>\`` },
  { id: "batch-anchored", req: "R2", claim: "Each batch is a hybrid transaction and carries the creator's ML-DSA-87 anchor signature.", check: "`npm run judge`" },
  { id: "round-in-anchor", req: "R2", claim: "The price round's hash is signed inside the anchor (`validator_set_hash` slot).", check: "`npm run judge` (round binding line)" },
  { id: "receipt-offchain", req: "R4", claim: "The settlement receipt passes all 6 RDK checks; a copy with one changed digit fails.", check: "`npm run judge`; the demo page's Verify tab" },
  { id: "contracts-deployed", req: "R4", claim: "`PriceFeed` and `ScoutLend` are deployed on the QoreChain EVM (chain 9800).", check: "`deployments/diana.json`; `eth_getCode` on each address" },
  { id: "receipt-evm", req: "R4", claim: "`PriceFeed.postRound` accepted a round only after `pqcVerify` checked the anchor signature on chain.", check: "Receipt of the tx below; `PriceFeed.verifyReceipt` via `eth_call`" },
  { id: "kem-key-registered", req: "R6", claim: "The opener's ML-KEM-1024 key is in the chain's KEM registry.", check: `\`curl ${REST}/qorechain/pqc/v1/kem/<operator qor1>\`` },
  { id: "sealed-report", req: "R6", claim: "Scouts post sealed reports (about 1.8 KB of ciphertext) and signed commitments to the rollup inbox.", check: "Tx below; round page on the demo site" },
  { id: "round-opened", req: "R6", claim: "After close the operator opens every report; each one matches its commitment.", check: "Tx below; watchtower `--observe`" },
  { id: "court-slash", req: "R5", claim: "The watchtower challenged a wrong median; the operator's bond was slashed and the price corrected.", check: "Tx below; `MedianChallenged` event" },
  { id: "chain-fraud-slash", req: "R5", claim: "The watchtower's fraud proof made the chain reject a wrong ledger root and slash the 1,000 QOR bond.", check: "Tx below (`MsgChallengeBatch`)" },
  { id: "reward-paid", req: "R3", claim: "In-band scouts are paid on the rollup ledger.", check: "Tx below; ledger replay" },
  { id: "withdrawal-executed", req: "R3", claim: "A scout withdrew its reward to QoreChain with a Merkle proof (`MsgExecuteWithdrawal`).", check: "Tx below" },
  { id: "lender-final-read", req: "R8", claim: "`ScoutLend` lent fUSD against fETH using a final, fresh price only.", check: "Tx below; Lender tab" },
];

const short = (h: string) => (h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h);

/** A link anyone can open with no account: REST JSON for native txs, a JSON-RPC call for EVM txs. */
export function txCell(tx: string, layer: "native" | "evm" = tx.startsWith("0x") ? "evm" : "native"): string {
  if (layer === "native") return `[\`${short(tx)}\`](${REST}/cosmos/tx/v1beta1/txs/${tx.replace(/^0x/, "").toUpperCase()})`;
  return `\`${short(tx)}\` (EVM: \`eth_getTransactionReceipt\` on ${EVM})`;
}

const isLive = (r: AttackRun) => /^live/i.test(r.note);

/** Evidence keys that point at something checkable, in the order a reader wants them. */
function evidenceCell(ev: AttackStep["evidence"], where: string): string {
  const tx = ev.txHash ?? ev.tx;
  const parts = Object.entries(ev).filter(([k]) => k !== "txHash" && k !== "tx").map(([k, v]) => `${k} \`${String(v).replace(/\|/g, "/")}\``);
  return [tx ? txCell(String(tx), where === "evm" ? "evm" : "native") : "", ...parts].filter(Boolean).join("<br>") || "·";
}

export function renderProof(proof: ProofFile | undefined, runs: AttackRun[], generatedAt: string): string {
  const rows = CLAIMS.map((c, i) => {
    const ev = proof?.claims[c.id];
    const cell = ev?.tx ? txCell(ev.tx, ev.layer) + (ev.note ? `<br>${ev.note}` : "") : ev?.note ?? "pending";
    return `| ${i + 1} | ${c.req} | ${c.claim} | ${cell} | ${c.check} |`;
  });
  const attackRows = runs.filter(isLive).flatMap((r) => r.steps.map((s) =>
    `| ${s.attack}${s.where === "simulation" ? " (simulation, local chain)" : ""} | ${s.step} | ${s.where} | **${s.verdict}** | ${evidenceCell(s.evidence, s.where)} |`));
  const done = rows.filter((r) => !r.includes("| pending |")).length;
  return [
    "# Proof",
    "",
    "Every claim in the README, with a transaction or a read anyone can repeat. None of the checks needs a key or an account.",
    `Network: QoreChain testnet \`qorechain-diana\` (EVM chain id 9800). ${done} of ${CLAIMS.length} claims have evidence so far.`,
    "",
    `This file is generated by \`npm run proof\` from \`evidence/claims.json\` and the attack runs in \`packages/attacks/evidence/\`. Last generated: ${generatedAt}.`,
    "",
    "## Claims",
    "",
    "| # | Req. | Claim | Evidence | How to check |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## Attacks",
    "",
    attackRows.length
      ? ["| Attack | Step | Where | Result | Evidence |", "|---|---|---|---|---|", ...attackRows].join("\n")
      : "No live attack runs recorded yet. `npm run redteam -w @sealed-scouts/attacks` records them in `packages/attacks/evidence/`.",
    "",
    "## Requirement key",
    "",
    "R1 rollup. R2 ML-DSA-signed batches. R3 withdrawal. R4 verified settlement receipt. R5 watchtower. R6 ML-KEM data protection. R8 monitoring and use. The threat model (R7) is in [THREAT_MODEL.md](THREAT_MODEL.md).",
    "",
  ].join("\n");
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readRuns(dir: string): Promise<AttackRun[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const runs = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => readJson<AttackRun>(join(dir, n))));
  return runs.filter((r): r is AttackRun => !!r && Array.isArray(r.steps)).sort((a, b) => a.at.localeCompare(b.at));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { claims: { type: "string" }, "attacks-dir": { type: "string" }, out: { type: "string" } } });
  const claims = values.claims ?? join(REPO_ROOT, "evidence/claims.json");
  const attacksDir = values["attacks-dir"] ?? join(REPO_ROOT, "packages/attacks/evidence");
  const out = values.out ?? join(REPO_ROOT, "PROOF.md");
  const md = renderProof(await readJson<ProofFile>(claims), await readRuns(attacksDir),
    new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC");
  await writeFile(out, md);
  console.log(`wrote ${out}`);
}
