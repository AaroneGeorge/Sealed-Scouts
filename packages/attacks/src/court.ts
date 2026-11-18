// A TypeScript model of PriceFeed.challengeMedian and of the chain's batch challenge, over a SimRollup, for the
// dry runs. The live runs use the real contract and the real chain; this model follows their rules:
// leaves must hash to the posted reportsRoot, the median is recomputed, an honest round cannot be slashed, and a
// slash pays half the bond to the challenger and burns half.
import { checkQledgerFraud } from "@qorechain/rdk";
import { feedMedians, reportsRoot, type Leaf } from "@sealed-scouts/core";
import type { Challenger, SimRollup } from "@sealed-scouts/watchtower";

export const BOND = 1_000_000_000n; // 1,000 QOR in uqor, the chain's min_submitter_bond

export class CourtRevert extends Error {}

export class SimCourt implements Challenger {
  readonly bonds = new Map<string, bigint>();
  readonly paid = new Map<string, bigint>();
  burned = 0n;
  private tx = 0;

  constructor(private readonly sim: SimRollup, private readonly challenger: string, readonly quorum = 3) {}

  private slash(who: string): void {
    const bond = this.bonds.get(who) ?? 0n;
    this.bonds.set(who, 0n);
    this.paid.set(this.challenger, (this.paid.get(this.challenger) ?? 0n) + bond / 2n);
    this.burned += bond - bond / 2n;
  }

  async challengeMedian(round: bigint, leaves: Leaf[]) {
    const f = this.sim.feedRounds.get(round);
    if (!f || f.status !== "pending") throw new CourtRevert(`NotPending(${round})`);
    if (reportsRoot(leaves) !== f.reportsRoot) throw new CourtRevert("RootMismatch");
    const fixed = feedMedians(leaves, this.quorum);
    const at = (id: number) => fixed.find((m) => m.feedId === id);
    const fault = leaves.length !== f.reportCount || f.feedIds.some((id, i) => (at(id)?.price ?? 0n) !== f.medians[i] || (at(id)?.count ?? 0) !== f.counts[i]);
    if (!fault) throw new CourtRevert(`HonestRound(${round})`);
    f.medians = f.feedIds.map((id) => at(id)?.price ?? 0n);
    f.counts = f.feedIds.map((id) => at(id)?.count ?? 0);
    f.status = "corrected";
    this.slash(this.sim.operator.address);
    return { txHash: `sim-tx-${++this.tx}` };
  }

  async challengeBatch(batchIndex: number, proof: Uint8Array) {
    const b = this.sim.batches[batchIndex];
    if (!b) throw new CourtRevert(`no batch ${batchIndex}`);
    // The chain's own decision procedure; a proof against an honest batch fails (chain error 51).
    if (!checkQledgerFraud(this.sim.env, b, proof)) return { txHash: `sim-tx-${++this.tx}`, code: 51 };
    b.status = "rejected";
    this.slash(`submitter:${batchIndex}`);
    return { txHash: `sim-tx-${++this.tx}`, code: 0 };
  }
}
