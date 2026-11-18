// The watchtower on the live chain: inbox and batches over REST, PriceFeed over read-only EVM calls.
// Only active mode needs a key (TOWER), to send challenges.
import { fetchPqKeyStatus } from "@qorechain/qoresign/network";
import { challengeBatchMsg } from "@qorechain/rdk";
import { toHex, type Leaf } from "@sealed-scouts/core";
import type { Account, Chain } from "@sealed-scouts/chain";
import { FEED_STATUS, PRICE_FEED_ABI } from "./abi.js";
import type { BatchInfo } from "./ledger.js";
import type { FeedRound } from "./rounds.js";
import type { Challenger, TowerSource } from "./source.js";

export function liveSource(chain: Chain, rollupId: string, priceFeed?: `0x${string}`): TowerSource {
  const rest = chain.inbox.rest;
  const pc = chain.evm.publicClient;
  const read = <T>(functionName: string, args: unknown[]) =>
    pc.readContract({ address: priceFeed!, abi: PRICE_FEED_ABI, functionName: functionName as never, args: args as never }) as Promise<T>;

  return {
    height: async () => BigInt(await rest.getLatestHeight()),
    inboxHead: () => chain.inbox.head(rollupId),
    readInbox: (from, to) => chain.inbox.read(rollupId, from, to),
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
      return { ...empty, feedIds, medians: points.map((p) => p[0]), counts: points.map((p) => Number(p[1])), reportsRoot, reportCount: Number(reportCount), batchIndex };
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
