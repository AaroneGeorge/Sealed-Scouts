// Wire the scout to the live chain through @sealed-scouts/chain.
import { fromHex } from "@sealed-scouts/core";
import { BONDS_ABI, bondEligible, type Account, type Chain } from "@sealed-scouts/chain";
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

/**
 * A scout's report counts only while it holds a bond on PriceFeed with no exit pending. Throws a plain
 * explanation when it does not, instead of posting reports the round will reject as "not-eligible".
 */
export async function assertBonded(chain: Chain, account: Account, priceFeed: `0x${string}` | undefined, listed: string[]): Promise<void> {
  if (!listed.includes(account.address)) throw new Error(`${account.address} is not in deployments/diana.json "scouts": its reports would not count`);
  if (!priceFeed) return; // before contracts exist every listed scout is eligible
  const [amount, exitAt, nonce] = await chain.evm.publicClient.readContract({ address: priceFeed, abi: BONDS_ABI, functionName: "bonds", args: [account.evm] });
  if (!bondEligible({ amount, exitAt, nonce })) {
    throw new Error(
      `${account.address} (${account.evm}) has no usable bond on PriceFeed ${priceFeed} ` +
        `(amount ${amount} wei, exitAt ${exitAt}): its reports would be rejected as not-eligible. ` +
        `Fund it with PriceFeed.bondFor(${account.evm}) (launch does this with SS_SCOUT_BOND_QOR).`,
    );
  }
}

/** The opener's registered ML-KEM-1024 key. Throws when it has none: a report must never be sealed to a guess. */
export async function registeredKemKey(chain: Chain, opener: string): Promise<Uint8Array> {
  const hex = await chain.native.kemKey(opener);
  if (!hex) throw new Error(`${opener} has no registered ML-KEM key`);
  return fromHex(hex);
}
