// The standard simulated history behind `watchtower --fixture` and the attack dry runs:
// six rounds of five scouts, one skipped report revealed by its scout, one outlier, one wrong median posted
// to the feed, reward payments, and one ledger batch with a wrong root between honest ones.
import { deriveRound, roundWindows, scoutAddress, type RoundResult } from "@sealed-scouts/core";
import { ledgerKeyOf } from "@sealed-scouts/scout";
import type { FeedRound } from "./rounds.js";
import { SimRollup } from "./sim.js";

const E8 = 100_000_000n;
const BASE = { 1: 1_754n * E8, 2: 62_570n * E8, 3: 99_930_000n } as const;

/** What an honest operator would post for a derived round. */
export function feedRoundFor(r: RoundResult, status: FeedRound["status"], batchIndex = 0n): FeedRound {
  return {
    status,
    feedIds: r.medians.map((m) => m.feedId),
    medians: r.medians.map((m) => m.price),
    counts: r.medians.map((m) => m.count),
    reportsRoot: r.reportsRoot,
    reportCount: r.leaves.length,
    batchIndex,
  };
}

export function derive(sim: SimRollup, round: bigint): RoundResult {
  return deriveRound(sim.entries, round, { ...sim.params, pqKeyOf: (s) => sim.pqKeys.get(s) }, (s) => sim.pqKeys.has(s));
}

/** Scout i's prices: a few basis points apart, as different venues give. */
export function scoutPrices(i: number, skew: (feedId: number) => bigint = () => 0n) {
  const feedIds = [1, 2, 3];
  return { feedIds, prices: feedIds.map((f) => BASE[f as 1 | 2 | 3] + (BASE[f as 1 | 2 | 3] * BigInt(i - 2)) / 5_000n + skew(f)) };
}

export interface DemoWorld { sim: SimRollup; wrongMedianRound: bigint; fraudBatch: number }

export function buildDemoWorld(): DemoWorld {
  const sim = new SimRollup();
  sim.deposit(sim.operatorLedger.accountId, 10_000_000n);
  const wrongMedianRound = 4n;
  let fraudBatch = -1;
  for (let round = 0n; round < 6n; round++) {
    const outlier = round === 3n ? 2 : -1;
    const reports = sim.reportRound(round, (i) => scoutPrices(i, (f) => (i === outlier ? BASE[f as 1 | 2 | 3] / 7n : 0n)));
    const skip = round === 2n ? [4] : [];
    sim.open(round, reports, skip);
    if (round === 2n) sim.reveal(round, 4, reports[4]!);
    sim.height = roundWindows(round, sim.params).revealEnd;

    const result = derive(sim, round);
    const posted = feedRoundFor(result, round >= 4n ? "pending" : "final", BigInt(sim.batches.length));
    if (round === wrongMedianRound) posted.medians = posted.medians.map((m, i) => (i === 0 ? 1n * E8 : m)); // fETH = $1
    sim.feedRounds.set(round, posted);

    for (const leaf of result.inBand) {
      const scout = sim.scouts.find((s) => scoutAddress(s.address) === leaf.scout)!;
      sim.pay(ledgerKeyOf(scout.keys.pqc.secretKey).accountId, 100_000n);
    }
    if (round === 1n || round === 5n) sim.submitBatch();
    if (round === 3n) fraudBatch = sim.submitBatch({ tamper: true }).batchIndex;
  }
  return { sim, wrongMedianRound, fraudBatch };
}

