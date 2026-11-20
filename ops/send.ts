// Send QOR from one of our roles to any address, after checking it, and print what FUNDS.md needs.
//   source ops/env.local.sh
//   npx tsx ops/send.ts ADDRESS QOR [--from ROLE]       default ROLE: OPERATOR
import { bank } from "@qorechain/sdk";
import { isCanonicalQorAddress } from "@qorechain/rdk";
import { chain, loadAccount, type Role } from "../packages/chain/src/index.js";

const [to, amount] = process.argv.slice(2);
const i = process.argv.indexOf("--from");
const role = (i > 0 ? process.argv[i + 1] : "OPERATOR") as Role;
if (!to || !amount) throw new Error("usage: npx tsx ops/send.ts ADDRESS QOR [--from ROLE]");
if (!isCanonicalQorAddress(to)) throw new Error(`${to} is not a valid qor1 address`);
const uqor = BigInt(Math.round(Number(amount) * 1e6));
if (uqor <= 0n) throw new Error(`amount must be positive, got ${amount}`);

const c = chain();
const from = await loadAccount(role);
const res = await c.native.sendOrThrow(from, [bank.send({ fromAddress: from.address, toAddress: to, amount: [{ denom: "uqor", amount: uqor.toString() }] })]);
console.log(`sent ${Number(uqor) / 1e6} QOR (${uqor} uqor) from ${role} ${from.address} to ${to}: ${res.txHash} (height ${res.height})`);
