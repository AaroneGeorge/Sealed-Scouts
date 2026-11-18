// Renders the day-1 evidence folder as a short markdown report (stdout).
//   npx tsx ops/day1/report.ts <evidence dir>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "";
const read = (name: string): any => {
  const f = join(dir, `${name}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
};
const lines: string[] = [`# Track C: day-1 chain tests (${new Date().toISOString()})`, "", `Evidence: ${dir}`, ""];
const summary = read("summary");
lines.push("## Steps", ...(summary?.steps ?? []).map((s: any) => `- ${s.step}: ${s.ok ? "ok" : `FAILED: ${s.error}`} (${s.seconds}s)`), "");

const keys = read("keys");
if (keys) {
  lines.push("## 1. ML-DSA-87 + ML-KEM key registration");
  for (const [role, k] of Object.entries<any>(keys)) {
    const tx = (x: any) => (typeof x === "string" ? x : `${x.txHash} (code ${x.code}, gas ${x.gasUsed})`);
    lines.push(`- ${role} ${k.address}: pqc ${tx(k.pqc)}; kem ${tx(k.kem)}`);
  }
  lines.push("");
}
const c = read("classical-refusal");
if (c) lines.push("## 2. Classical-only tx", `- refused: ${c.refused}; code ${c.code} (${c.codespace}); tx ${c.txHash}`, `- log: \`${c.rawLog}\``, "");
const p = read("inbox-post");
if (p) {
  lines.push(
    "## 3. REPORT + COMMIT in one tx to the organiser rollup",
    `- tx ${p.txHash} height ${p.height}, gas ${p.gasUsed}; ${p.messagesInOneTx} posts: REPORT ${p.reportBytes} B, COMMIT ${p.commitBytes} B`,
    `- inbox sequences ${p.sequences.join(", ")}; read back identical: ${p.readBackIdentical}`,
    "",
  );
}
const e = read("evm-probe");
if (e) {
  const k = e.check;
  lines.push(
    "## 4. EVM window + live anchor through pqcVerify",
    `- probe ${e.deployed.address} deployed in ${e.deployed.hash} (gas ${e.deployed.gasUsed})`,
    `- anchor ${e.anchor.rollupId} batch ${e.anchor.batchIndex}: view valid ${k.viewOk}, tampered ${k.viewTampered}`,
    `- checkAnchor ${k.hash}: gas used ${k.gasUsed} of limit ${k.gasLimit} (estimate ${k.estimate}); billed ${k.billedGasFromBalance}; billed >= half limit: ${k.billedAtLeastHalfLimit}; gas inside contract for the check ${k.gasInsideContractForCheck}; calldata ${k.calldataBytes} B`,
    "",
  );
}
console.log(lines.join("\n"));
