// Top up the scouts' reward pool: the operator deposits QOR into its own account on the rollup ledger. Each deposit
// is also an inbox entry, so the next batch has something to settle.
//   source ops/env.local.sh
//   npx tsx ops/deposit-pool.ts [QOR]          default 20
import { depositToRollupMsg } from "@qorechain/rdk";
import { chain, loadAccount } from "../packages/chain/src/index.js";
import { ledgerKeyOf } from "../packages/scout/src/index.js";
import { readDeployment } from "../packages/operator/src/deployment.js";

const c = chain();
const rollupId = readDeployment()?.rollupId ?? "sealed-scouts-1";
const amount = BigInt(Math.round(Number(process.argv[2] ?? "20") * 1e6));
const op = await loadAccount("OPERATOR");
const account = ledgerKeyOf(op.keys.pqc.secretKey).accountId;
const res = await c.native.sendOrThrow(op, [depositToRollupMsg({ depositor: op.address, rollupId, account, amount })]);
console.log(`deposited ${Number(amount) / 1e6} QOR to the reward pool of ${rollupId}: ${res.txHash} (height ${res.height})`);
