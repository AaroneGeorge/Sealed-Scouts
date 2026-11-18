// Wire the scout to the live chain through @sealed-scouts/chain.
import { fromHex } from "@sealed-scouts/core";
import type { Account, Chain } from "@sealed-scouts/chain";
import type { ScoutChain } from "./scout.js";

export function liveScoutChain(chain: Chain, account: Account, rollupId: string): ScoutChain {
  return {
    height: async () => BigInt(await chain.inbox.rest.getLatestHeight()),
    inboxHead: () => chain.inbox.head(rollupId),
    readInbox: async (fromSeq, toSeq) => (toSeq > fromSeq ? chain.inbox.read(rollupId, fromSeq + 1n, toSeq) : []),
    post: async (payloads) => {
      const r = await chain.native.postToInbox(account, payloads, rollupId);
      return { txHash: r.txHash, code: r.code, height: r.height };
    },
  };
}

/** The opener's registered ML-KEM-1024 key. Throws when it has none: a report must never be sealed to a guess. */
export async function registeredKemKey(chain: Chain, opener: string): Promise<Uint8Array> {
  const hex = await chain.native.kemKey(opener);
  if (!hex) throw new Error(`${opener} has no registered ML-KEM key`);
  return fromHex(hex);
}
