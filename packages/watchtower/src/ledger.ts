// Replay the rollup's qledger-v1 ledger batch by batch and catch a wrong root. Uses the RDK's own
// executeQledger / buildQledgerFraudProof / checkQledgerFraud, the code the chain's fraud proof runs.
// (transitionRootValidator is the wrong tool here: it flags honest qledger batches.)
import {
  EMPTY_INBOX_ACC, QledgerLedger, bytesToHex, buildQledgerFraudProof, checkQledgerFraud, executeQledger, qledgerAccumulate,
  type QledgerEntry,
} from "@qorechain/rdk";
import type { InboxEntry } from "@sealed-scouts/core";

/** What a batch published, as the chain reports it (BatchView fields we use). */
export interface BatchInfo {
  batchIndex: number;
  inboxStart: number;
  inboxEnd: number;
  dataHash: string;
  prevStateRoot: string;
  stateRoot: string;
  withdrawalsRoot: string;
  status: string;
}

export interface BatchCheck {
  batchIndex: number;
  verdict: "ok" | "fraud" | "skipped";
  entries: number;
  honestStateRoot?: string;
  honestWithdrawalsRoot?: string;
  /** Encoded fraud proof for MsgChallengeBatch, already confirmed with checkQledgerFraud. */
  proof?: Uint8Array;
  note?: string;
}

const norm = (h: string | Uint8Array | undefined): string => {
  const s = (typeof h === "string" ? h : h ? bytesToHex(h) : "").toLowerCase().replace(/^0x/, "");
  return /^0*$/.test(s) ? "" : s; // an empty withdrawals root may be served as "" or as zeros
};

export class LedgerReplay {
  /** State after the last batch that stands (not rejected). */
  private ledger = new QledgerLedger();
  private next = 0;

  /** The ledger after the last batch that stands: the parent state of the next batch. */
  state(): QledgerLedger {
    return this.ledger.clone();
  }

  /** The first batch index not checked yet. */
  get nextIndex(): number {
    return this.next;
  }

  constructor(private readonly env: { chainId: string; rollupId: string }) {}

  /**
   * Check every batch not checked yet, in index order. `entries` is the whole inbox from sequence 1, so the
   * accumulator at any batch start can be rebuilt locally.
   */
  replay(batches: BatchInfo[], entries: InboxEntry[]): BatchCheck[] {
    const bySeq = [...entries].sort((a, b) => (a.seq < b.seq ? -1 : 1));
    const out: BatchCheck[] = [];
    for (const b of [...batches].sort((x, y) => x.batchIndex - y.batchIndex)) {
      if (b.batchIndex < this.next) continue;
      if (BigInt(b.inboxEnd) > (bySeq.at(-1)?.seq ?? 0n)) break; // inbox not read that far yet: retry next pass
      out.push(this.check(b, bySeq));
      this.next = b.batchIndex + 1;
    }
    return out;
  }

  private check(b: BatchInfo, bySeq: InboxEntry[]): BatchCheck {
    const toQ = (e: InboxEntry): QledgerEntry => ({ height: e.height, poster: e.poster, payload: e.payload });
    const consumed = bySeq.filter((e) => e.seq > BigInt(b.inboxStart) && e.seq <= BigInt(b.inboxEnd)).map(toQ);
    if (b.status === "rejected") return { batchIndex: b.batchIndex, verdict: "skipped", entries: consumed.length, note: "rejected on chain" };
    if (norm(b.prevStateRoot) !== norm(this.ledger.root())) {
      return { batchIndex: b.batchIndex, verdict: "skipped", entries: consumed.length, note: "parent root differs from our replay" };
    }
    const after = this.ledger.clone();
    const honest = executeQledger(this.env, after, consumed);
    if (norm(honest.stateRoot) === norm(b.stateRoot) && norm(honest.withdrawalsRoot) === norm(b.withdrawalsRoot)) {
      this.ledger = after;
      return { batchIndex: b.batchIndex, verdict: "ok", entries: consumed.length };
    }
    const accFrom = qledgerAccumulate({ ...this.env, from: 0, accFrom: EMPTY_INBOX_ACC, entries: bySeq.filter((e) => e.seq <= BigInt(b.inboxStart)).map(toQ) });
    const { proof } = buildQledgerFraudProof(this.env, this.ledger.clone(), accFrom, consumed);
    // Decide it exactly as the chain will before spending a challenge on it.
    let fraud: boolean;
    try {
      fraud = checkQledgerFraud(this.env, b, proof);
    } catch (e) {
      return { batchIndex: b.batchIndex, verdict: "skipped", entries: consumed.length, note: `proof cannot decide: ${(e as Error).message}` };
    }
    if (!fraud) {
      this.ledger = after;
      return { batchIndex: b.batchIndex, verdict: "ok", entries: consumed.length, note: "roots differ in form only; the chain's check finds no fraud" };
    }
    // A wrong batch never becomes the parent: the next honest batch builds on the same state.
    return {
      batchIndex: b.batchIndex,
      verdict: "fraud",
      entries: consumed.length,
      honestStateRoot: bytesToHex(honest.stateRoot),
      honestWithdrawalsRoot: bytesToHex(honest.withdrawalsRoot),
      proof,
    };
  }
}
