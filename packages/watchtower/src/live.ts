// The watchtower on the live chain: inbox and batches over REST, PriceFeed over read-only EVM calls.
// Only active mode needs a key (TOWER), to send challenges.
import { fetchPqKeyStatus } from "@qorechain/qoresign/network";
import { challengeBatchMsg, isRestNotFound } from "@qorechain/rdk";
import { toHex, type Leaf } from "@sealed-scouts/core";
import { ScoutEligibility, type Account, type Chain } from "@sealed-scouts/chain";
import { timingOf, type Deployment } from "@sealed-scouts/scout";
import { FEED_STATUS, PRICE_FEED_ABI } from "./abi.js";
import type { BatchInfo } from "./ledger.js";
import type { FeedRound } from "./rounds.js";
import type { Challenger, TowerSource } from "./source.js";
import type { TowerConfig } from "./tower.js";

/** `demo` must match the operator's choice, or rounds are cut at different heights. */
export function towerConfigFrom(d: Deployment, demo: boolean): TowerConfig {
  return { params: { ...timingOf(d, demo), ...d.rules, chainId: d.chainId, rollupId: d.rollupId, operator: d.operator }, scouts: d.scouts, evmChainId: BigInt(d.evmChainId) };
}

/** How far back to look for a round's RoundPosted event, in EVM blocks per query and in total. */
const LOG_CHUNK = 10_000n;
const LOG_LOOKBACK = 400_000n;

export function liveSource(chain: Chain, d: Pick<Deployment, "rollupId" | "scouts" | "priceFeed">): TowerSource {
  const { rollupId, priceFeed } = d;
  const rest = chain.inbox.rest;
  // The same eligibility rule and snapshot height as the operator, so both derive the same rounds.
  const eligibility = new ScoutEligibility(chain.evm.publicClient, d.scouts, priceFeed);
  const snapshotted = new Set<bigint>();
  const pc = chain.evm.publicClient;
  type Posted = Pick<FeedRound, "attestation" | "anchor">;
  const posted = new Map<bigint, Posted>();
  let twoSig: Promise<boolean> | undefined;

  /** postRound's arguments, from the RoundPosted event (storage keeps only part of them). Newest blocks first. */
  async function postedRound(round: bigint): Promise<Posted | undefined> {
    if (posted.has(round)) return posted.get(round);
    const latest = await pc.getBlockNumber();
    for (let to = latest; to >= 0n && latest - to < LOG_LOOKBACK; to -= LOG_CHUNK) {
      const from = to >= LOG_CHUNK ? to - LOG_CHUNK + 1n : 0n;
      const logs = await pc.getContractEvents({ address: priceFeed!, abi: PRICE_FEED_ABI, eventName: "RoundPosted", args: { round }, fromBlock: from, toBlock: to });
      const ev = logs.at(-1)?.args;
      if (ev?.att) {
        const a = ev.att;
        const p: Posted = {
          attestation: { ...a, feedIds: [...a.feedIds], medians: [...a.medians], counts: [...a.counts] },
          anchor: { stateRoot: ev.stateRoot!, txCount: ev.txCount!, anchorSig: ev.anchorSig! },
        };
        posted.set(round, p);
        return p;
      }
      if (from === 0n) break;
    }
    return undefined;
  }
  const read = <T>(functionName: string, args: unknown[]) =>
    pc.readContract({ address: priceFeed!, abi: PRICE_FEED_ABI, functionName: functionName as never, args: args as never }) as Promise<T>;

  return {
    eligibility: async (round, closeHeight) => {
      if (!snapshotted.has(round)) {
        const snap = await eligibility.snapshot(round, closeHeight);
        // The tower publishes the round as "unknown" with this reason and tries again next pass.
        if (snap.status === "unknown") throw new Error(`eligibility unknown at height ${closeHeight}: ${snap.reason}`);
        snapshotted.add(round);
      }
      return eligibility.eligible;
    },
    height: async () => BigInt(await rest.getLatestHeight()),
    inboxHead: () => chain.inbox.head(rollupId),
    readInbox: (from, to) => chain.inbox.read(rollupId, from, to),
    // Binary search on post heights. A post the chain no longer retains is older than any it keeps, so it
    // counts as "before" the height we look for.
    firstSeqAtOrAfter: async (height) => {
      let lo = 1n;
      let hi = BigInt((await rest.getInbox(rollupId)).headSequence) + 1n;
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        const h = await rest.getPostedData(rollupId, mid).then((p) => BigInt(p.height), (e) => (isRestNotFound(e) ? -1n : Promise.reject(e)));
        if (h >= height) hi = mid;
        else lo = mid + 1n;
      }
      return lo;
    },
    batches: async (fromIndex) =>
      (await rest.listBatches(rollupId, { startIndex: fromIndex })).map(
        (b): BatchInfo => ({
          batchIndex: b.batchIndex, inboxStart: b.inboxStart, inboxEnd: b.inboxEnd, dataHash: b.dataHash, prevStateRoot: b.prevStateRoot,
          stateRoot: b.stateRoot, withdrawalsRoot: b.withdrawalsRoot, status: b.status,
        }),
      ),
    pqKey: async (address) => {
      const s = await fetchPqKeyStatus({ rest: chain.config.rest, address, fetch: chain.fetch });
      return s.registered ? s.publicKey : undefined;
    },
    feedRound: async (round): Promise<FeedRound | undefined> => {
      if (!priceFeed) return undefined;
      const status = FEED_STATUS[Number(await read<number>("status", [round]))]!;
      const empty: FeedRound = { status, feedIds: [], medians: [], counts: [], reportsRoot: `0x${"00".repeat(32)}`, reportCount: 0, batchIndex: 0n };
      if (status === "none") return empty;
      const [reportsRoot, , , batchIndex, reportCount] = await read<[`0x${string}`, bigint, bigint, bigint, number, boolean]>("rounds", [round]);
      const feedIds = (await read<readonly number[]>("roundFeeds", [round])).map(Number);
      const points = await Promise.all(feedIds.map((f) => read<[bigint, number, boolean]>("points", [round, f])));
      twoSig ??= read<boolean>("twoSigMode", []);
      return {
        ...empty, feedIds, medians: points.map((p) => p[0]), counts: points.map((p) => Number(p[1])), reportsRoot, reportCount: Number(reportCount), batchIndex,
        ...(await postedRound(round)), twoSig: await twoSig,
      };
    },
  };
}

export const leafArg = (l: Leaf) => ({ round: l.round, scout: l.scout, salt: toHex(l.salt), feedIds: l.feedIds, prices: l.prices, commitSigHash: l.commitSigHash });

export function liveChallenger(chain: Chain, tower: Account, rollupId: string, priceFeed?: `0x${string}`): Challenger {
  return {
    async challengeMedian(round, leaves) {
      if (!priceFeed) throw new Error("no PriceFeed address in the deployment");
      return chain.evm.withWindow(tower, { targets: [priceFeed], maxTxs: 1, blocks: 60 }, async (s) => {
        const hash = await s.walletClient.writeContract({
          address: priceFeed, abi: PRICE_FEED_ABI, functionName: "challengeMedian", args: [round, leaves.map(leafArg)], gas: 2_500_000n,
        });
        const receipt = await s.publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`challengeMedian reverted (tx ${hash})`);
        return { txHash: hash };
      });
    },
    async challengeBatch(batchIndex, proof) {
      const r = await chain.native.send(tower, [challengeBatchMsg({ challenger: tower.address, rollupId, batchIndex, proof })]);
      return { txHash: r.txHash, code: r.code };
    },
  };
}
