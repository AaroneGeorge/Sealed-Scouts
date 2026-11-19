// npm run receipt -w @sealed-scouts/operator -- [--rollup ID] [--batch N] [--out FILE]
// Builds the RDK settlement receipt of an anchored batch, verifies it against live chain state (six checks),
// then verifies a copy with one changed state-root character, which must fail.
// --out FILE writes the bare receipt in the format of `qorollup receipt --out`, so anyone can check it with
// `npx @qorechain/rdk-cli@0.9.0 receipt verify FILE`. The tampered copy goes next to it as FILE.tampered.json.
import { writeFileSync } from "node:fs";
import { createRdkClient, verifySettlementReceipt, type SettlementReceipt, buildSettlementReceipt } from "@qorechain/rdk";
import { chain } from "@sealed-scouts/chain";
import { readDeployment } from "./deployment.js";

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const c = chain();
const client = createRdkClient({ network: "testnet", endpoints: { rest: c.config.rest, evmRpc: c.config.evmRpc }, fetch: c.fetch });
const rollupId = option("--rollup") ?? readDeployment()?.rollupId;
if (!rollupId) throw new Error("no rollup: pass --rollup or create deployments/diana.json");
const batch = option("--batch") !== undefined ? Number(option("--batch")) : (await client.rest.getLatestBatch(rollupId)).batchIndex;

const receipt = await buildSettlementReceipt(client, rollupId, batch);
const honest = await verifySettlementReceipt(receipt, { client });
print(`receipt ${rollupId} batch ${batch}`, honest);

const tampered: SettlementReceipt = { ...receipt, stateRoot: flipHexChar(receipt.stateRoot) };
const bad = await verifySettlementReceipt(tampered, { client });
print("tampered copy (one state-root character changed)", bad);

const out = option("--out");
if (out) {
  writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(out.replace(/\.json$/, "") + ".tampered.json", JSON.stringify(tampered, null, 2) + "\n");
  console.log(`wrote ${out}; check it with: npx @qorechain/rdk-cli@0.9.0 receipt verify ${out}`);
}
process.exitCode = honest.valid && !bad.valid ? 0 : 1;

function print(title: string, v: Awaited<ReturnType<typeof verifySettlementReceipt>>) {
  const checks = Object.entries(v.checks);
  console.log(`${title}: ${v.valid ? "VALID" : "INVALID"} (${checks.filter(([, ok]) => ok).length} of ${checks.length} checks)`);
  for (const [name, ok] of checks) console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`);
}

function flipHexChar(h: string): string {
  const i = h.length - 1;
  return h.slice(0, i) + (h[i] === "0" ? "1" : "0");
}
