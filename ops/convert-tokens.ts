// Test tokens can arrive as bank coins (denom "erc20:0x…", the chain's x/erc20 representation). ScoutLend only sees
// the ERC-20 balance of the account's 0x address, so convert them first with MsgConvertCoin.
//   source ops/env.local.sh
//   npx tsx ops/convert-tokens.ts [ROLE]          convert every erc20:0x… bank coin of ROLE (default OPERATOR)
import { BinaryWriter } from "cosmjs-types/binary";
import { chain, loadAccount, type Role } from "../packages/chain/src/index.js";
import { registry } from "../packages/chain/src/native.js";

const TYPE_URL = "/cosmos.evm.erc20.v1.MsgConvertCoin";
interface MsgConvertCoin { coin: { denom: string; amount: string }; receiver: string; sender: string }
const MsgConvertCoinType = {
  encode(m: MsgConvertCoin, w: BinaryWriter = BinaryWriter.create()) {
    const coin = BinaryWriter.create();
    coin.uint32(10).string(m.coin.denom).uint32(18).string(m.coin.amount);
    w.uint32(10).bytes(coin.finish());
    w.uint32(18).string(m.receiver);
    w.uint32(26).string(m.sender);
    return w;
  },
  decode(): MsgConvertCoin {
    throw new Error("decode not needed");
  },
  fromPartial(m: MsgConvertCoin) {
    return m;
  },
};
registry.register(TYPE_URL, MsgConvertCoinType as never);

const c = chain();
const role = (process.argv[2] ?? "OPERATOR") as Role;
const a = await loadAccount(role);
const res = await fetch(`${c.config.rest}/cosmos/bank/v1beta1/balances/${a.address}`);
const coins = ((await res.json()) as { balances: { denom: string; amount: string }[] }).balances.filter((b) => b.denom.startsWith("erc20:"));
if (coins.length === 0) {
  console.log(`${role}: no erc20:0x… bank coins to convert`);
  process.exit(0);
}
const msgs = coins.map((coin) => ({ typeUrl: TYPE_URL, value: { coin, receiver: a.evm, sender: a.address } }));
for (const coin of coins) console.log(`${role}: converting ${coin.amount} ${coin.denom} to ERC-20 at ${a.evm}`);
console.log(`tx ${(await c.native.sendOrThrow(a, msgs)).txHash}`);
