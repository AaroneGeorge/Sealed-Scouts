// ScoutLend on the live feed: the operator supplies fUSD, deposits fETH and borrows fUSD. borrow() reads both prices
// with PriceFeed.readFinal, so it only goes through on a final (past the challenge window), fresh round.
//   source ops/env.local.sh
//   npx tsx ops/lend.ts [--supply 200] [--deposit 0.1] [--borrow 50]       amounts in tokens
//   npx tsx ops/lend.ts --dry-run                                          prices and balances only
import { evmWindowCost } from "@qorechain/evm";
import { erc20Abi, parseUnits, formatUnits, type Hex } from "viem";
import { chain, loadAccount } from "../packages/chain/src/index.js";
import { artifact } from "../packages/operator/src/contracts.js";
import { readDeployment } from "../packages/operator/src/deployment.js";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const MAX_FEE_PER_GAS = 250_000_000_000n;
const c = chain();
const d = readDeployment();
const lend = d?.contracts?.ScoutLend as Hex | undefined;
const feed = d?.contracts?.PriceFeed as Hex | undefined;
if (!lend || !feed) throw new Error("no ScoutLend/PriceFeed in deployments/diana.json: run the launch first");
const op = await loadAccount("OPERATOR");
const pub = c.evm.publicClient;
const lendAbi = artifact("ScoutLend").abi;
const feedAbi = artifact("PriceFeed").abi;

const [feth, fusd, maxAge] = await Promise.all([
  pub.readContract({ address: lend, abi: lendAbi, functionName: "collateralToken" }) as Promise<Hex>,
  pub.readContract({ address: lend, abi: lendAbi, functionName: "debtToken" }) as Promise<Hex>,
  pub.readContract({ address: lend, abi: lendAbi, functionName: "maxPriceAge" }) as Promise<bigint>,
]);
const [dE, dU] = await Promise.all([feth, fusd].map((t) => pub.readContract({ address: t, abi: erc20Abi, functionName: "decimals" })));
for (const [name, id] of [["fETH", 1], ["fUSD", 3]] as const) {
  const r = await pub.readContract({ address: feed, abi: feedAbi, functionName: "readFinal", args: [id, maxAge] }).catch((e: Error) => e);
  console.log(r instanceof Error ? `${name}: no final fresh price (${r.message.split("\n")[0]})` : `${name}: $${formatUnits((r as [bigint, bigint])[0], 8)} (round ${(r as [bigint, bigint])[1]})`);
}
for (const [name, t, dec] of [["fETH", feth, dE], ["fUSD", fusd, dU]] as const) {
  console.log(`operator ${name}: ${formatUnits(await pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [op.evm] }), dec!)}`);
}
if (process.argv.includes("--dry-run")) process.exit(0);

const supply = parseUnits(arg("--supply", "200"), dU!);
const deposit = parseUnits(arg("--deposit", "0.1"), dE!);
const borrow = parseUnits(arg("--borrow", "50"), dU!);
const calls = [
  { address: fusd, abi: erc20Abi, functionName: "approve", args: [lend, supply] },
  { address: lend, abi: lendAbi, functionName: "supply", args: [supply] },
  { address: feth, abi: erc20Abi, functionName: "approve", args: [lend, deposit] },
  { address: lend, abi: lendAbi, functionName: "deposit", args: [deposit] },
  { address: lend, abi: lendAbi, functionName: "borrow", args: [borrow] },
] as const;
const maxValue = evmWindowCost({ gas: 300_000n, maxFeePerGas: MAX_FEE_PER_GAS }) * BigInt(calls.length);
const hashes = await c.evm.withWindow(op, { targets: [lend, feth, fusd], maxTxs: calls.length, blocks: 300, maxValue }, async ({ publicClient, walletClient }) => {
  const out: Hex[] = [];
  for (const call of calls) {
    const gas = await publicClient.estimateContractGas({ ...call, account: op.evm } as never);
    const hash = await walletClient.writeContract({ ...call, gas: (gas * 120n) / 100n, maxFeePerGas: MAX_FEE_PER_GAS } as never);
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${call.functionName} tx ${hash} reverted`);
    console.log(`${call.functionName}: ${hash}`);
    out.push(hash);
  }
  return out;
});
console.log(`borrowed ${formatUnits(borrow, dU!)} fUSD against ${formatUnits(deposit, dE!)} fETH at final prices: ${hashes.at(-1)}`);
