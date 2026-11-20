// Show balances, or top up roles from OPERATOR (the faucet pays one address per day, so the operator
// claims and spreads it on chain).
//   source ops/env.local.sh
//   npx tsx ops/fund.ts                       balances of every role
//   npx tsx ops/fund.ts --topup [QOR]         bring SCOUT1-3, TOWER, ATTACKER, RELAYER up to QOR each (default 5)
//   npx tsx ops/fund.ts --fund ROLE=QOR,...   bring each named role up to that many QOR from OPERATOR, in one tx
//   npx tsx ops/fund.ts --register ROLE,...   register each role's ML-DSA-87 and ML-KEM-1024 keys (it must hold QOR);
//                                             the chain refuses any message from an account without its ML-DSA key
import { bank } from "@qorechain/sdk";
import { ROLES, chain, loadAccount, type Role } from "../packages/chain/src/index.js";

const c = chain();
const TOPUP_ROLES: Role[] = ["SCOUT1", "SCOUT2", "SCOUT3", "TOWER", "ATTACKER", "RELAYER"];
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

const f = process.argv.indexOf("--fund");
if (f > 0) {
  const op = await loadAccount("OPERATOR");
  const msgs = [];
  for (const pair of (process.argv[f + 1] ?? "").split(",").filter(Boolean)) {
    const [role, amount] = pair.split("=") as [Role, string];
    const a = await loadAccount(role);
    const missing = BigInt(Math.round(Number(amount) * 1e6)) - (await c.native.balance(a.address));
    if (missing <= 0n) { console.log(`${role} already holds ${amount} QOR`); continue; }
    console.log(`${role}: sending ${qor(missing)} QOR to ${a.address}`);
    msgs.push(bank.send({ fromAddress: op.address, toAddress: a.address, amount: [{ denom: "uqor", amount: missing.toString() }] }));
  }
  if (msgs.length > 0) {
    const res = await c.native.sendOrThrow(op, msgs);
    console.log(`funded in one tx: ${res.txHash} (height ${res.height})`);
  }
}

const r = process.argv.indexOf("--register");
if (r > 0) {
  for (const role of (process.argv[r + 1] ?? "").split(",").filter(Boolean) as Role[]) {
    const a = await loadAccount(role);
    const pqc = await c.native.registerPqcKey(a);
    const kem = await c.native.registerKemKey(a);
    const show = (x: typeof pqc) => (x === "already-registered" ? x : x.txHash);
    console.log(`${role}: ML-DSA-87 ${show(pqc)}, ML-KEM-1024 ${show(kem)}`);
  }
}
