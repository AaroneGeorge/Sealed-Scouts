// PriceFeed and ScoutLend on the diana EVM: deploy (Track B's compiled artifacts, same constructor arguments
// and env vars as contracts/script/Deploy.s.sol), fund bonds, and the receipt gate the relay runs before posting.
import { readFileSync } from "node:fs";
import { evmWindowCost, toEvmAddress } from "@qorechain/evm";
import { pqcSign } from "@qorechain/sdk";
import { encodeDeployData, type Abi, type Hex } from "viem";
import type { Account, Chain } from "@sealed-scouts/chain";
import { MESSAGE_PQ_DOMAIN, type RoundAttestation } from "@sealed-scouts/core";

const OUT_ABI = new URL("../../../contracts/out-abi/", import.meta.url).pathname;
/** Fest test tokens on diana (Deploy.s.sol). */
const FETH = "0x02292293c13880a26242690eb70a0e42B8E91c28";
const FUSD = "0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const MAX_FEE_PER_GAS = 250_000_000_000n;

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

export function artifact(name: "PriceFeed" | "ScoutLend"): Artifact {
  const j = JSON.parse(readFileSync(`${OUT_ABI}${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: (typeof j.bytecode === "string" ? j.bytecode : j.bytecode.object) as Hex };
}

export interface FeedConfig {
  operator: `0x${string}`;
  nativeChainId: string;
  rollupId: string;
  twoSig: boolean;
  challengeWindow: bigint;
  exitDelay: bigint;
  minOperatorBond: bigint;
  feth: `0x${string}`;
  fusd: `0x${string}`;
  ltvBps: number;
  liqBps: number;
  maxPriceAge: bigint;
}

/** Same defaults and env vars as Deploy.s.sol, so both deploy paths build the same contracts. */
export function feedConfig(d: { operatorEvm: `0x${string}`; rollupId: string; chainId: string }, env: NodeJS.ProcessEnv = process.env): FeedConfig {
  return {
    operator: (env.SS_OPERATOR ?? d.operatorEvm) as `0x${string}`,
    nativeChainId: env.SS_NATIVE_CHAIN_ID ?? d.chainId,
    rollupId: env.SS_ROLLUP_ID ?? d.rollupId,
    twoSig: env.SS_TWO_SIG === "true",
    challengeWindow: BigInt(env.SS_CHALLENGE_WINDOW ?? "120"),
    exitDelay: BigInt(env.SS_EXIT_DELAY ?? "300"),
    minOperatorBond: BigInt(env.SS_MIN_OPERATOR_BOND ?? 10n ** 19n),
    feth: (env.SS_FETH ?? FETH) as `0x${string}`,
    fusd: (env.SS_FUSD ?? FUSD) as `0x${string}`,
    ltvBps: Number(env.SS_LTV_BPS ?? "5000"),
    liqBps: Number(env.SS_LIQ_BPS ?? "8000"),
    maxPriceAge: BigInt(env.SS_MAX_PRICE_AGE ?? "900"),
  };
}

export interface Deployed {
  PriceFeed: `0x${string}`;
  ScoutLend: `0x${string}`;
  txs: { PriceFeed: Hex; ScoutLend: Hex };
  gasUsed: { PriceFeed: bigint; ScoutLend: bigint };
}

/** Deploy both contracts inside one UNSCOPED window: a target-scoped window refuses contract creation. */
export async function deployContracts(chain: Chain, deployer: Account, c: FeedConfig): Promise<Deployed> {
  const feed = artifact("PriceFeed");
  const lend = artifact("ScoutLend");
  const maxValue = evmWindowCost({ gas: 8_000_000n, maxFeePerGas: MAX_FEE_PER_GAS }) * 2n;
  return chain.evm.withWindow(deployer, { targets: [], maxTxs: 2, blocks: 400, maxValue }, async ({ publicClient, walletClient }) => {
    const deploy = async (a: Artifact, args: readonly unknown[]) => {
      const gas = await publicClient.estimateGas({ account: deployer.evm, data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) });
      const hash = await walletClient.deployContract({ abi: a.abi, bytecode: a.bytecode, args, gas: (gas * 110n) / 100n, maxFeePerGas: MAX_FEE_PER_GAS });
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy tx ${hash} failed`);
      return { address: rc.contractAddress, hash, gasUsed: rc.gasUsed };
    };
    const f = await deploy(feed, [c.operator, c.nativeChainId, c.rollupId, c.twoSig, c.challengeWindow, c.exitDelay, c.minOperatorBond]);
    const l = await deploy(lend, [f.address, c.feth, c.fusd, 1, 3, c.ltvBps, c.liqBps, c.maxPriceAge]);
    return { PriceFeed: f.address, ScoutLend: l.address, txs: { PriceFeed: f.hash, ScoutLend: l.hash }, gasUsed: { PriceFeed: f.gasUsed, ScoutLend: l.gasUsed } };
  });
}

/**
 * Fund bonds on PriceFeed from `payer`: the operator's (bondOperator) and each scout's (bondFor). Anyone may pay a
 * bond, so the operator can fund its scouts. One window scoped to the feed covers every call.
 */
export async function fundBonds(
  chain: Chain,
  payer: Account,
  feed: `0x${string}`,
  bonds: { operatorWei: bigint; scouts: { qor1: string; wei: bigint }[] },
): Promise<Hex[]> {
  const abi = artifact("PriceFeed").abi;
  const calls = [
    ...(bonds.operatorWei > 0n ? [{ functionName: "bondOperator", args: [] as unknown[], value: bonds.operatorWei }] : []),
    ...bonds.scouts.filter((s) => s.wei > 0n).map((s) => ({ functionName: "bondFor", args: [toEvmAddress(s.qor1)] as unknown[], value: s.wei })),
  ];
  if (calls.length === 0) return [];
  const valueUqor = calls.reduce((t, c) => t + c.value, 0n) / 10n ** 12n + 1n;
  const maxValue = valueUqor + evmWindowCost({ gas: 200_000n, maxFeePerGas: MAX_FEE_PER_GAS }) * BigInt(calls.length);
  return chain.evm.withWindow(payer, { targets: [feed], maxTxs: calls.length, blocks: 300, maxValue }, async ({ publicClient, walletClient }) => {
    const hashes: Hex[] = [];
    for (const call of calls) {
      const gas = await publicClient.estimateContractGas({ address: feed, abi, ...call, account: payer.evm });
      const hash = await walletClient.writeContract({ address: feed, abi, ...call, gas: (gas * 120n) / 100n, maxFeePerGas: MAX_FEE_PER_GAS });
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`${call.functionName} tx ${hash} reverted`);
      hashes.push(hash);
    }
    return hashes;
  });
}

/**
 * The second signature of two-signature mode (SPEC Changes 14): the creator's ML-DSA-87 signature over the
 * QoreSign bytes of `sealed-scouts/round/v1|<rollupId>|<round>|<roundHash, 64 lowercase hex>`.
 */
export function roundSigBytes(nativeChainId: string, rollupId: string, round: bigint, roundHash: Hex): Uint8Array {
  const text = `sealed-scouts/round/v1|${rollupId}|${round}|${roundHash.slice(2).toLowerCase()}`;
  return new TextEncoder().encode(`${MESSAGE_PQ_DOMAIN}${nativeChainId}|${text}`);
}

export function roundSignature(creator: Account, nativeChainId: string, rollupId: string, round: bigint, roundHash: Hex): Uint8Array {
  return pqcSign(creator.keys.pqc.secretKey, roundSigBytes(nativeChainId, rollupId, round, roundHash));
}

/** PriceFeed's own view check of a round, the gate before any postRound. */
export async function verifyOnFeed(chain: Chain, feed: `0x${string}`, att: RoundAttestation, stateRoot: Hex, txCount: bigint, sig: Hex): Promise<boolean> {
  return (await chain.evm.publicClient.readContract({
    address: feed,
    abi: artifact("PriceFeed").abi,
    functionName: "verifyReceipt",
    args: [att, stateRoot, txCount, sig],
  })) as boolean;
}

export async function feedTwoSigMode(chain: Chain, feed: `0x${string}`): Promise<boolean> {
  return (await chain.evm.publicClient.readContract({ address: feed, abi: artifact("PriceFeed").abi, functionName: "twoSigMode" })) as boolean;
}
