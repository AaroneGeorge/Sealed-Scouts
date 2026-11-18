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
  /** Settlement batches from index `fromIndex` on. */
  batches(fromIndex: number): Promise<BatchInfo[]>;
  /** The scout's registered ML-DSA-87 key, or undefined when it has none. */
  pqKey(scout: string): Promise<Uint8Array | undefined>;
  /** The round as PriceFeed holds it; undefined when there is no feed contract to read. */
  feedRound(round: bigint): Promise<FeedRound | undefined>;
  /**
   * Who may report in `round`, read as of its close height (the operator's rule). Without it the tower uses
   * TowerConfig.scouts, or every poster with a registered key (fixture mode).
   */
  eligibility?(round: bigint, closeHeight: bigint): Promise<(scout: string, round: bigint) => boolean>;
}

export interface Challenger {
  challengeMedian(round: bigint, leaves: Leaf[]): Promise<{ txHash: string }>;
  challengeBatch(batchIndex: number, proof: Uint8Array): Promise<{ txHash: string; code: number }>;
}
