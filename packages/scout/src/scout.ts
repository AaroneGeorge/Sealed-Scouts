// One scout bot. Each round: read prices, post REPORT + COMMIT in the commit window, then check that the
// operator opened the report; if it did not, post REVEAL in the grace window so the report still counts.
import { bytesEqual, commitment, decodeMsg, phaseOf, roundWindows, type InboxEntry, type PriceSet, type RoundTiming } from "@sealed-scouts/core";
import type { FeedPrice, PriceReading } from "./prices/index.js";
import { buildReveal, buildSealedReport, type ScoutSigner, type SealedReport } from "./report.js";

export interface PostResult { txHash: string; code: number; height: bigint }

/** What the scout needs from the chain. The live adapter wraps @sealed-scouts/chain; tests use fakes. */
export interface ScoutChain {
  height(): Promise<bigint>;
  /** Sequence of the newest inbox post (0 = none). */
  inboxHead(): Promise<bigint>;
  /** Inbox posts with sequence in (fromSeq, toSeq]. */
  readInbox(fromSeq: bigint, toSeq: bigint): Promise<InboxEntry[]>;
  post(payloads: Uint8Array[]): Promise<PostResult>;
}

export interface ScoutConfig {
  chainId: string;
  rollupId: string;
  /** qor1 of the opener: the only poster whose OPEN counts. */
  operator: string;
  timing: RoundTiming;
  /** Do not start a post with fewer blocks than this left in the commit window: it may land too late. */
  commitMarginBlocks?: bigint;
}

export interface ScoutDeps {
  config: ScoutConfig;
  signer: ScoutSigner;
  chain: ScoutChain;
  readPrices: () => Promise<PriceReading>;
  openerKemKey: () => Promise<Uint8Array>;
  log?: (line: string) => void;
}

export const toPriceSet = (feeds: FeedPrice[]): PriceSet => ({ feedIds: feeds.map((f) => f.feedId), prices: feeds.map((f) => f.price) });

interface Posted { sealed: SealedReport; headBefore: bigint; settled: boolean }

export class Scout {
  private readonly posted = new Map<bigint, Posted>();
  private readonly log: (line: string) => void;

  constructor(private readonly d: ScoutDeps) {
    this.log = d.log ?? ((l) => console.log(l));
  }

  /** Read prices, seal, sign, and post REPORT + COMMIT for `round`. Undefined when no feed had enough sources. */
  async report(round: bigint): Promise<{ sealed: SealedReport; tx: PostResult } | undefined> {
    const reading = await this.d.readPrices();
    for (const f of reading.failed) this.log(`round ${round}: ${f.venue} excluded (${f.error})`);
    for (const s of reading.skipped) this.log(`round ${round}: feed ${s.feedId} skipped (${s.reason})`);
    if (reading.feeds.length === 0) {
      this.log(`round ${round}: no feed has enough sources, not reporting`);
      return undefined;
    }
    const { chainId, rollupId } = this.d.config;
    const sealed = buildSealedReport({ chainId, rollupId, round, scout: this.d.signer, openerKemKey: await this.d.openerKemKey(), prices: toPriceSet(reading.feeds) });
    const headBefore = await this.d.chain.inboxHead();
    const tx = await this.d.chain.post([sealed.report, sealed.commit]);
    if (tx.code !== 0) throw new Error(`round ${round}: post refused with code ${tx.code} (tx ${tx.txHash})`);
    this.posted.set(round, { sealed, headBefore, settled: false });
    this.log(`round ${round}: REPORT ${sealed.report.length} B + COMMIT ${sealed.commit.length} B posted at ${tx.height} (tx ${tx.txHash})`);
    return { sealed, tx };
  }

  /** True when an OPEN from the operator, or our own REVEAL, already discloses this report. */
  disclosed(entries: InboxEntry[], sealed: SealedReport): boolean {
    return entries.some((e) => {
      const m = decodeMsg(e.payload);
      if (!m || m.kind === "JOIN" || m.round !== sealed.round) return false;
      if (m.kind === "REVEAL") return e.poster === this.d.signer.address;
      if (m.kind !== "OPEN" || e.poster !== this.d.config.operator) return false;
      return m.openings.some((o) => o.scout.toLowerCase() === sealed.scout20 && bytesEqual(commitment(sealed.round, sealed.scout20, o.salt, o), sealed.commitment));
    });
  }

  /** One step of the loop. Safe to call as often as you like. */
  async tick(): Promise<void> {
    const { timing } = this.d.config;
    const height = await this.d.chain.height();
    const { round, phase } = phaseOf(height, timing);
    const margin = this.d.config.commitMarginBlocks ?? 10n;
    if (phase === "commit" && !this.posted.has(round) && roundWindows(round, timing).commitEnd - height > margin) {
      await this.report(round);
    }
    for (const [r, p] of this.posted) {
      const w = roundWindows(r, timing);
      if (height >= w.revealEnd) {
        if (!p.settled) this.log(`round ${r}: report was never disclosed before the reveal window closed`);
        this.posted.delete(r);
      } else if (height >= w.openEnd && !p.settled) {
        const entries = await this.d.chain.readInbox(p.headBefore, await this.d.chain.inboxHead());
        if (this.disclosed(entries, p.sealed)) p.settled = true;
        else {
          const tx = await this.d.chain.post([buildReveal(p.sealed)]);
          p.settled = tx.code === 0;
          this.log(`round ${r}: operator skipped our report; REVEAL posted (code ${tx.code}, tx ${tx.txHash})`);
        }
      }
    }
  }
}
