// What the watchtower reads and (in active mode) sends. Observe mode needs no key at all.
import type { InboxEntry, Leaf } from "@sealed-scouts/core";
import type { BatchInfo } from "./ledger.js";
import type { FeedRound } from "./rounds.js";

export interface TowerSource {
  height(): Promise<bigint>;
  /** Sequence of the newest inbox post (0 = none). */
  inboxHead(): Promise<bigint>;
  /** Inbox posts fromSeq..toSeq, both included. */
  readInbox(fromSeq: bigint, toSeq: bigint): Promise<InboxEntry[]>;
  /** The first inbox sequence posted at or after `height`, or head + 1 when there is none yet. */
  firstSeqAtOrAfter(height: bigint): Promise<bigint>;
  /** Settlement batches from index `fromIndex` on. */
  batches(fromIndex: number): Promise<BatchInfo[]>;
  /** The scout's registered ML-DSA-87 key, or undefined when it has none. */
  pqKey(scout: string): Promise<Uint8Array | undefined>;
  /** The round as PriceFeed holds it; undefined when there is no feed contract to read. */
  feedRound(round: bigint): Promise<FeedRound | undefined>;
  /**
   * Who may report in `round`, read as of its close height (the operator's rule). Without it the tower uses
   * TowerConfig.scouts, or every poster with a registered key (fixture mode). Throws when it cannot be read; the
   * tower then marks that round "unknown" and carries on.
   */
  eligibility?(round: bigint, closeHeight: bigint): Promise<(scout: string, round: bigint) => boolean>;
  /**
   * Every fraud proof the chain upheld against this rollup (its rdk_fraud_upheld events), from any challenger.
   * A rejected batch is replaced by the next one at the same index, so replaying batches alone cannot count them.
   */
  fraudUpheld?(): Promise<UpheldFraud[]>;
}

export interface UpheldFraud {
  batchIndex: number;
  submitter: string;
  challenger: string;
  slashedUqor: string;
  challengerRewardUqor: string;
  txHash: string;
  height: string;
  time: string;
}

export interface Challenger {
  challengeMedian(round: bigint, leaves: Leaf[]): Promise<{ txHash: string }>;
  challengeBatch(batchIndex: number, proof: Uint8Array): Promise<{ txHash: string; code: number }>;
}
