// Show balances, or top up roles from OPERATOR (the faucet pays one address per day, so the operator
// claims and spreads it on chain).
//   source ops/env.local.sh
//   npx tsx ops/fund.ts                       balances of every role
//   npx tsx ops/fund.ts --topup [QOR]         bring SCOUT1-3, TOWER, ATTACKER up to QOR each (default 5)
import { bank } from "@qorechain/sdk";
import { ROLES, chain, loadAccount, type Role } from "../packages/chain/src/index.js";

const c = chain();
const TOPUP_ROLES: Role[] = ["SCOUT1", "SCOUT2", "SCOUT3", "TOWER", "ATTACKER"];
const qor = (u: bigint) => (Number(u) / 1e6).toFixed(3);

for (const role of ROLES) {
  const a = await loadAccount(role);
  console.log(`${role.padEnd(9)} ${a.address} ${qor(await c.native.balance(a.address))} QOR`);
}

const i = process.argv.indexOf("--topup");
if (i > 0) {
  const target = BigInt(Math.round(Number(process.argv[i + 1] ?? "5") * 1e6));
  const op = await loadAccount("OPERATOR");
  const reg = await c.native.registerPqcKey(op);
  if (reg !== "already-registered") console.log(`OPERATOR ML-DSA-87 key registered: ${reg.txHash}`);
  const msgs = [];
  for (const role of TOPUP_ROLES) {
    const a = await loadAccount(role);
    const missing = target - (await c.native.balance(a.address));
    if (missing > 0n) msgs.push(bank.send({ fromAddress: op.address, toAddress: a.address, amount: [{ denom: "uqor", amount: missing.toString() }] }));
  }
  if (msgs.length === 0) console.log("every role already holds the target");
  else console.log(`top-up of ${msgs.length} roles in one tx: ${(await c.native.sendOrThrow(op, msgs)).txHash}`);
}
