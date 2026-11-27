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
 * The RDK's searchTxs reads at most 50 pages of 100 transactions, oldest first, and stops there without an
 * error: a search window holding more posts than that loses its newest ones. Reads are cut into chunks well
 * below that, and every search is bounded by the heights of the posts it needs.
 */
export const INBOX_READ_CHUNK = 1000n;

/** How far to look past a post the chain no longer retains for a neighbour whose height bounds a search. */
const BOUND_PROBES = 8n;

/**
 * A RestClient whose transaction searches only cover the heights [minHeight, maxHeight], so reading a few
 * entries does not page through the rollup's whole history. The bounds only narrow the search: every entry
 * found is still checked against the chain's inbox accumulator, so a wrong bound fails a read, never
 * changes what it returns.
 */
export class BoundedRest extends RestClient {
  constructor(
    base: string,
    fetch: FetchLike,
    readonly minHeight: bigint,
    readonly maxHeight?: bigint,
  ) {
    super(base, { fetch });
  }
  override searchTxs(query: string, opts?: { pageLimit?: number; maxPages?: number }) {
    let q = query;
    if (this.minHeight > 0n) q += ` AND tx.height>=${this.minHeight}`;
    if (this.maxHeight !== undefined) q += ` AND tx.height<=${this.maxHeight}`;
    return super.searchTxs(q, opts);
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
    const out: InboxEntry[] = [];
    for (let a = fromSeq; a <= toSeq; a += INBOX_READ_CHUNK) {
      const b = a + INBOX_READ_CHUNK - 1n < toSeq ? a + INBOX_READ_CHUNK - 1n : toSeq;
      out.push(...(await this.readChunk(rollupId, a, b, head)));
    }
    return out;
  }

  /**
   * A RestClient for the RDK's own inbox reads (planQledgerBatch) of the posts fromSeq..toSeq: its tx
   * searches start at the height of post fromSeq and, when toSeq is given, end at the height of post toSeq.
   * A bound whose post (and its near neighbours) the chain no longer retains is left open.
   */
  async searchWindow(rollupId: string, fromSeq: bigint, toSeq?: bigint): Promise<BoundedRest> {
    let min = 0n;
    for (let s = fromSeq; s >= 1n && s > fromSeq - BOUND_PROBES; s--) {
      const p = await this.posted(rollupId, s);
      if (p) {
        min = p.height;
        break;
      }
    }
    let max: bigint | undefined;
    if (toSeq !== undefined) {
      const head = await this.head(rollupId);
      for (let s = toSeq; s <= head && s < toSeq + BOUND_PROBES; s++) {
        const p = await this.posted(rollupId, s);
        if (p) {
          max = p.height;
          break;
        }
      }
    }
    return new BoundedRest(this.opts.config.rest, this.opts.fetch, min, max);
  }

  private async readChunk(rollupId: string, fromSeq: bigint, toSeq: bigint, head: bigint): Promise<InboxEntry[]> {
    const start = await this.startPoint(rollupId, fromSeq - 1n);
    // The accumulator check needs the chain's commitment at the end of the range; posts that are
    // no longer retained are checked against the head instead.
    const endPost = await this.posted(rollupId, toSeq);
    const end = endPost ? toSeq : head;
    const bounded = new BoundedRest(this.opts.config.rest, this.opts.fetch, start.height, endPost?.height);
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

  /** The chain's commitment of post `seq`, or undefined once it is no longer retained. */
  private async posted(rollupId: string, seq: bigint): Promise<{ height: bigint } | undefined> {
    try {
      return { height: BigInt((await this.rest.getPostedData(rollupId, seq)).height) };
    } catch (err) {
      if (isRestNotFound(err)) return undefined;
      throw err;
    }
  }
}

function toInboxEntry(e: QledgerEntry, seq: bigint): InboxEntry {
  return { seq, height: BigInt(e.height), poster: e.poster, payload: e.payload };
}
