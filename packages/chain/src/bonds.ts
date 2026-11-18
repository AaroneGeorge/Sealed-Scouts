// Scout eligibility, the one rule the operator and every watchtower must apply the same way.
// A scout counts in round R only if it is listed in the deployment AND, on PriceFeed at the round's close
// height, holds a bond with no exit pending. Reading at a fixed height (not "now") makes the answer the same
// for everyone who replays the round later; the EVM block number equals the native height on QoreChain.
import { toEvmAddress } from "@qorechain/evm";
import { parseAbi, type Chain, type PublicClient, type Transport } from "viem";

export const BONDS_ABI = parseAbi(["function bonds(address who) view returns (uint128 amount, uint64 exitAt, uint64 nonce)"]);

export interface BondState {
  amount: bigint;
  exitAt: bigint;
  nonce: bigint;
}

/** A bond that can be slashed for this round: something staked and no exit started. */
export function bondEligible(b: BondState): boolean {
  return b.amount > 0n && b.exitAt === 0n;
}

/** What a snapshot found: the eligible scouts, or why the chain could not say. */
export type EligibilitySnapshot = { status: "ok"; eligible: Set<string> } | { status: "unknown"; reason: string };

export class ScoutEligibility {
  private readonly listed: Set<string>;
  /** round -> qor1 scouts eligible in it. */
  private readonly snapshots = new Map<bigint, Set<string>>();

  /**
   * @param priceFeed Without a PriceFeed (before contracts exist) every listed scout is eligible.
   */
  constructor(
    private readonly client: PublicClient<Transport, Chain>,
    scouts: string[],
    private readonly priceFeed?: `0x${string}`,
  ) {
    this.listed = new Set(scouts);
  }

  /**
   * Read every listed scout's bond as of `closeHeight` (the round's first block after its commit window).
   * Never throws for a failed read: a pruned block, a block before PriceFeed existed, or an RPC error gives
   * `{ status: "unknown", reason }` and no snapshot is kept, so `eligible()` still refuses to answer for that
   * round. The operator retries such a round later; a watchtower marks the round "unknown" and moves on.
   */
  async snapshot(round: bigint, closeHeight: bigint): Promise<EligibilitySnapshot> {
    const ok = new Set<string>();
    for (const scout of this.listed) {
      if (!this.priceFeed) {
        ok.add(scout);
        continue;
      }
      let bond: readonly [bigint, bigint, bigint];
      try {
        bond = await this.client.readContract({
          address: this.priceFeed,
          abi: BONDS_ABI,
          functionName: "bonds",
          args: [toEvmAddress(scout)],
          blockNumber: closeHeight,
        });
      } catch (err) {
        return { status: "unknown", reason: `bonds(${scout}) at block ${closeHeight}: ${(err as Error).message.split("\n")[0]}` };
      }
      if (bondEligible({ amount: bond[0], exitAt: bond[1], nonce: bond[2] })) ok.add(scout);
    }
    this.snapshots.set(round, ok);
    return { status: "ok", eligible: ok };
  }

  /** The callback core's deriveRound takes. A round without a snapshot is an error, never "nobody". */
  readonly eligible = (scout: string, round: bigint): boolean => {
    const s = this.snapshots.get(round);
    if (!s) throw new Error(`no eligibility snapshot for round ${round}: call snapshot(round, closeHeight) first`);
    return s.has(scout);
  };

  /** Drop snapshots of rounds that are done. */
  forget(round: bigint): void {
    this.snapshots.delete(round);
  }
}
