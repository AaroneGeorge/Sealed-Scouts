// The standard simulated history behind `watchtower --fixture` and the attack dry runs:
// six rounds of five scouts, one skipped report revealed by its scout, one outlier, one wrong median posted
// to the feed, reward payments, and one batch per round, plus one ledger batch with a wrong root.
import { deriveRound, roundWindows, scoutAddress, toAttestation, type RoundAttestation, type RoundResult } from "@sealed-scouts/core";
import { ledgerKeyOf } from "@sealed-scouts/scout";
import { feedRoundFromAttestation, type FeedRound } from "./rounds.js";
import { SimRollup } from "./sim.js";

const E8 = 100_000_000n;
const BASE = { 1: 1_754n * E8, 2: 62_570n * E8, 3: 99_930_000n } as const;

type BatchRef = Parameters<typeof toAttestation>[1];

/** What an honest operator would post for a derived round, anchored in `batch`. */
export function feedRoundFor(r: RoundResult, status: FeedRound["status"], batch: BatchRef = { index: 0n, inboxStart: 0n, inboxEnd: 0n, closeTime: 0n }): FeedRound {
  return feedRoundFromAttestation(toAttestation(r, batch), status);
}

/** Simulated block times: 1.3 s blocks from a fixed start, so recorded runs stay identical. */
const SIM_EPOCH = 1_795_000_000n;
const blockTime = (height: bigint) => SIM_EPOCH + (height * 13n) / 10n;

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
    for (const leaf of result.inBand) {
      const scout = sim.scouts.find((s) => scoutAddress(s.address) === leaf.scout)!;
      sim.pay(ledgerKeyOf(scout.keys.pqc.secretKey).accountId, 100_000n);
    }
    // One batch per round, as PriceFeed requires; round 3's batch is first submitted with a wrong root.
    if (round === 3n) fraudBatch = sim.submitBatch({ tamper: true }).batchIndex;
    const b = sim.submitBatch();
    const batch = { index: BigInt(b.batchIndex), inboxStart: BigInt(b.inboxStart), inboxEnd: BigInt(b.inboxEnd), closeTime: blockTime(roundWindows(round, sim.params).commitEnd) };
    let att: RoundAttestation = toAttestation(result, batch);
    if (round === wrongMedianRound) att = { ...att, medians: att.medians.map((m, i) => (i === 0 ? 1n * E8 : m)) }; // fETH = $1, signed as such
    sim.feedRounds.set(round, feedRoundFromAttestation(att, round >= 4n ? "pending" : "final"));
  }
  return { sim, wrongMedianRound, fraudBatch };
}

