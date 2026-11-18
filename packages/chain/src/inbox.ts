// Read a rollup inbox back from the chain. The chain keeps only commitments; the bytes live in the
// posting transactions. The RDK's fetchQledgerEntries finds them and checks them against the chain's
// inbox accumulator, so every entry we return is the one the chain ordered.
import {
  EMPTY_INBOX_ACC,
  RestClient,
  fetchQledgerEntries,
  isQledgerCheckpoint,
  isRestNotFound,
  type QledgerEntry,
} from "@qorechain/rdk";
import type { ChainConfig } from "./config.js";
import type { FetchLike } from "./http.js";

/** Same shape as the core package's InboxEntry (docs/SPEC.md). */
export interface InboxEntry {
  seq: bigint;
  height: bigint;
  poster: string;
  payload: Uint8Array;
}

/**
 * A RestClient whose transaction searches start at a known height, so reading recent entries does
 * not page through the rollup's whole history.
 */
class BoundedRest extends RestClient {
  constructor(
    base: string,
    fetch: FetchLike,
    private readonly minHeight: bigint,
  ) {
    super(base, { fetch });
  }
  override searchTxs(query: string, opts?: { pageLimit?: number; maxPages?: number }) {
    return super.searchTxs(this.minHeight > 0n ? `${query} AND tx.height>=${this.minHeight}` : query, opts);
  }
}

export class InboxReader {
  readonly rest: RestClient;

  constructor(private readonly opts: { config: ChainConfig; fetch: FetchLike }) {
    this.rest = new RestClient(opts.config.rest, { fetch: opts.fetch });
  }

  /** Head of the inbox: the highest sequence posted so far. */
  async head(rollupId: string): Promise<bigint> {
    return BigInt((await this.rest.getInbox(rollupId)).headSequence);
  }

  /**
   * Entries fromSeq..toSeq, both included (sequences start at 1). Throws if any entry is missing or
   * the bytes do not match the chain's accumulator: a failed read is an error, never an empty list.
   */
  async read(rollupId: string, fromSeq: bigint, toSeq: bigint): Promise<InboxEntry[]> {
    if (fromSeq < 1n || toSeq < fromSeq) throw new Error(`bad inbox range ${fromSeq}..${toSeq}`);
    const head = await this.head(rollupId);
    if (toSeq > head) throw new Error(`inbox of ${rollupId} ends at ${head}, asked up to ${toSeq}`);

    const start = await this.startPoint(rollupId, fromSeq - 1n);
    // The accumulator check needs the chain's commitment at the end of the range; posts that are
    // no longer retained are checked against the head instead.
    const end = (await this.retained(rollupId, toSeq)) ? toSeq : head;
    const bounded = new BoundedRest(this.opts.config.rest, this.opts.fetch, start.height);
    const entries = await fetchQledgerEntries(bounded, {
      chainId: this.opts.config.chainId,
      rollupId,
      from: start.seq,
      to: end,
      accFrom: start.acc,
    });
    return entries
      .map((e, i) => toInboxEntry(e, start.seq + 1n + BigInt(i)))
      .filter((e) => e.seq >= fromSeq && e.seq <= toSeq);
  }

  /** The latest point at or before `seq` whose accumulator the chain still holds. */
  private async startPoint(rollupId: string, seq: bigint): Promise<{ seq: bigint; acc: string | Uint8Array; height: bigint }> {
    const candidates = [seq, seq - (seq % 64n)];
    const inbox = await this.rest.getInbox(rollupId);
    const consumed = BigInt(inbox.consumedSequence);
    for (const c of candidates) {
      if (c <= 0n) break;
      if (c !== seq && !isQledgerCheckpoint(c)) continue;
      try {
        const p = await this.rest.getPostedData(rollupId, c);
        return { seq: c, acc: p.inboxAcc, height: BigInt(p.height) };
      } catch (err) {
        if (!isRestNotFound(err)) throw err;
      }
    }
    if (consumed > 0n && consumed <= seq) return { seq: consumed, acc: inbox.consumedAcc, height: 0n };
    return { seq: 0n, acc: EMPTY_INBOX_ACC, height: 0n };
  }

  private async retained(rollupId: string, seq: bigint): Promise<boolean> {
    try {
      await this.rest.getPostedData(rollupId, seq);
      return true;
    } catch (err) {
      if (isRestNotFound(err)) return false;
      throw err;
    }
  }
}

function toInboxEntry(e: QledgerEntry, seq: bigint): InboxEntry {
  return { seq, height: BigInt(e.height), poster: e.poster, payload: e.payload };
}
