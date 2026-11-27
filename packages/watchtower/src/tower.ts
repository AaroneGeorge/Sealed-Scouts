// The watchtower: replays every round and every ledger batch from chain data, publishes what it finds, and in
// active mode challenges a wrong median (EVM court) or a wrong ledger root (chain fraud proof).
import { decodeMsg, roundHash, roundOf, roundWindows, type InboxEntry, type RoundParams } from "@sealed-scouts/core";
import type { FeedWriter } from "./feed.js";
import { LedgerReplay, type BatchCheck } from "./ledger.js";
import { checkRound, type RoundCheck } from "./rounds.js";
import type { Challenger, TowerSource, UpheldFraud } from "./source.js";

export interface TowerConfig {
  params: Omit<RoundParams, "pqKeyOf">;
  /** qor1 accounts allowed to report. Empty = every poster with a registered key (no eligibility list yet). */
  scouts: string[];
  /** EVM chain id: the round hash domain (9800 on testnet). */
  evmChainId: bigint;
  /** Judge only these rounds (inclusive) and read only their part of the inbox. Needs `ledger: false`. */
  rounds?: { from: bigint; to: bigint };
  /** Replay ledger batches (default true). It needs the inbox from sequence 1. */
  ledger?: boolean;
}

/** A challenge the tower sent, or in observe mode would have sent (`sent: false`). */
export interface Challenge { kind: "median" | "batch"; target: string; sent: boolean; txHash?: string; code?: number; error?: string; at: string }

/** A round is settled once the feed can no longer change: final, corrected, or no quorum to post. */
const SETTLED = new Set(["match", "corrected", "no-quorum"]);

/**
 * Settled, or never posted while a later round is on the feed: PriceFeed only takes rounds above its last one, so
 * that round can no longer be posted either.
 */
const done = (r: { round: bigint; verdict: string; feed?: { status?: string } | null }, postedUpTo: bigint) =>
  (SETTLED.has(r.verdict) && r.feed?.status !== "pending") || (r.verdict === "not-posted" && r.round < postedUpTo);
const onFeed = (status: string | undefined) => status !== undefined && status !== "none";

export class Watchtower {
  private entries: InboxEntry[] = [];
  private readonly keys = new Map<string, Uint8Array | undefined>();
  private readonly rounds = new Map<bigint, RoundCheck>();
  /** Rounds whose last check failed (e.g. a chain read), with the error. Retried every pass. */
  private readonly unknown = new Map<bigint, string>();
  private readonly batchChecks: BatchCheck[] = [];
  readonly challenges: Challenge[] = [];
  private readonly challenged = new Set<string>();
  private readonly ledger: LedgerReplay;
  private height = 0n;
  /** Highest round seen on the feed (posted, final or corrected); -1 = none yet. */
  private postedUpTo = -1n;
  private upheld: UpheldFraud[] = [];
  private upheldReadAt = 0;

  constructor(
    private readonly cfg: TowerConfig,
    private readonly source: TowerSource,
    private readonly feed: FeedWriter,
    private readonly challenger?: Challenger,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {
    if (cfg.rounds && cfg.ledger !== false) throw new Error("a round range needs the ledger replay off: it reads only part of the inbox");
    this.ledger = new LedgerReplay(cfg.params);
  }

  get mode(): "observe" | "active" {
    return this.challenger ? "active" : "observe";
  }

  /** One full pass: read new inbox posts and batches, judge, challenge, publish. */
  async sync(): Promise<void> {
    this.height = await this.source.height();
    const [from, to] = await this.inboxRange();
    if (to >= from) this.entries.push(...(await this.source.readInbox(from, to)));

    await this.checkRounds();
    if (this.cfg.ledger !== false) await this.checkBatches();
    await this.readUpheld();
    this.publishStatus();
  }

  /**
   * The inbox sequences to read next. Normally everything after what we have. With a round range, only the posts
   * from the first round's start height to the end of the last round's reveal window, found by height.
   */
  private async inboxRange(): Promise<[bigint, bigint]> {
    const head = await this.source.inboxHead();
    const have = this.entries.at(-1)?.seq;
    const r = this.cfg.rounds;
    if (!r) return [(have ?? 0n) + 1n, head];
    const first = have !== undefined ? have + 1n : await this.source.firstSeqAtOrAfter(roundWindows(r.from, this.cfg.params).start);
    const last = (await this.source.firstSeqAtOrAfter(roundWindows(r.to, this.cfg.params).revealEnd)) - 1n;
    return [first, last < head ? last : head];
  }

  /**
   * Rounds that have posts, taken from the heights the chain gave them, not from the round number a message
   * claims (anyone can post any number). A message claiming another round is ignored, as deriveRound does.
   */
  private roundsWithPosts(): bigint[] {
    const { params } = this.cfg;
    const rounds = new Set<bigint>();
    for (const e of this.entries) {
      if (e.height < params.genesisHeight) continue;
      const m = decodeMsg(e.payload);
      const round = roundOf(e.height, params);
      if (m && m.kind !== "JOIN" && m.round === round) rounds.add(round);
    }
    const r = this.cfg.rounds;
    return [...rounds].filter((x) => !r || (x >= r.from && x <= r.to)).sort((a, b) => (a < b ? -1 : 1));
  }

  private async checkRounds(): Promise<void> {
    for (const round of this.roundsWithPosts()) {
      if (this.height < roundWindows(round, this.cfg.params).revealEnd) continue; // reveals may still land
      const prev = this.rounds.get(round);
      if (prev && done(prev, this.postedUpTo)) continue;
      // One round that cannot be read (a failed historical call, a node hiccup) must not stop the others or the
      // batch checks: it is published as "unknown" and retried next pass.
      try {
        await this.checkOne(round, prev);
        if (this.unknown.delete(round)) this.log(`round ${round}: readable again`);
      } catch (e) {
        const error = (e as Error).message;
        if (this.unknown.get(round) !== error) this.log(`round ${round}: unknown (${error})`);
        this.unknown.set(round, error);
        this.feed.round(round, { round, verdict: "unknown", error });
      }
    }
  }

  private async checkOne(round: bigint, prev: RoundCheck | undefined): Promise<void> {
    const { params } = this.cfg;
    const w = roundWindows(round, params);
    const inRound = this.entries.filter((e) => e.height >= w.start && e.height < w.revealEnd);
    await this.loadKeys(inRound);
    const eligible = this.source.eligibility
      ? await this.source.eligibility(round, w.commitEnd)
      : (scout: string) => (this.cfg.scouts.length === 0 ? this.keys.get(scout) !== undefined : this.cfg.scouts.includes(scout));
    const check = checkRound(inRound, round, { ...params, pqKeyOf: (s) => this.keys.get(s) }, eligible, await this.source.feedRound(round, w.revealEnd));
    this.rounds.set(round, check);
    if (onFeed(check.feed?.status) && round > this.postedUpTo) this.postedUpTo = round;
    if (!prev || prev.verdict !== check.verdict || prev.feed?.status !== check.feed?.status) {
      this.log(`round ${round}: ${check.verdict}${check.leftOut.length ? `, ${check.leftOut.length} report(s) left out of OPEN` : ""}`);
    }
    if (check.verdict === "median-wrong" && check.feed?.status === "pending") {
      await this.act("median", `round ${round}`, () => this.challenger!.challengeMedian(round, check.derived.leaves));
    }
    this.feed.round(round, roundJson(check, this.challenges.filter((c) => c.target === `round ${round}`), { chainId: this.cfg.evmChainId, rollupId: params.rollupId }));
  }

  private async checkBatches(): Promise<void> {
    for (const b of this.ledger.replay(await this.source.batches(this.ledger.nextIndex), this.entries)) {
      this.batchChecks.push(b);
      this.log(`batch ${b.batchIndex}: ${b.verdict} (${b.entries} entries)${b.note ? `, ${b.note}` : ""}`);
      if (b.verdict === "fraud") await this.act("batch", `batch ${b.batchIndex}`, () => this.challenger!.challengeBatch(b.batchIndex, b.proof!));
    }
  }

  /** Upheld fraud proofs from the chain, at most once a minute: they survive restarts, unlike our own replay. */
  private async readUpheld(): Promise<void> {
    if (!this.source.fraudUpheld || Date.now() - this.upheldReadAt < 60_000) return;
    try {
      this.upheld = await this.source.fraudUpheld();
      this.upheldReadAt = Date.now();
    } catch (e) {
      this.log(`fraud-upheld events: ${(e as Error).message}; keeping the last list`);
    }
  }

  /** Send a challenge once per target, in active mode only. Observe mode records what it would do. */
  private async act(kind: Challenge["kind"], target: string, send: () => Promise<{ txHash: string; code?: number }>): Promise<void> {
    if (this.challenged.has(target)) return;
    this.challenged.add(target);
    const at = new Date().toISOString();
    if (!this.challenger) {
      this.log(`${target}: challengeable (observe mode: not sending)`);
      this.challenges.push({ kind, target, at, sent: false });
      return;
    }
    try {
      const r = await send();
      this.challenges.push({ kind, target, at, sent: true, txHash: r.txHash, code: r.code });
      this.log(`${target}: ${kind} challenge sent, tx ${r.txHash}${r.code ? ` code ${r.code}` : ""}`);
    } catch (e) {
      this.challenges.push({ kind, target, at, sent: false, error: (e as Error).message });
      this.log(`${target}: ${kind} challenge failed: ${(e as Error).message}`);
    }
  }

  private async loadKeys(entries: InboxEntry[]): Promise<void> {
    for (const e of entries) {
      if (this.keys.has(e.poster) || decodeMsg(e.payload)?.kind !== "COMMIT") continue;
      this.keys.set(e.poster, await this.source.pqKey(e.poster));
    }
  }

  /**
   * Take back the rounds this tower already settled in an earlier run, from the round files it wrote (FeedWriter).
   * Only rounds that can no longer change are taken (the ones a pass skips anyway), so a restart does not spend
   * hours re-reading every finished round from the chain. Everything else is checked again as usual.
   */
  restore(records: Record<string, any>[]): number {
    const valid = records.filter((r) => typeof r.round === "string" && /^\d+$/.test(r.round));
    for (const r of valid) if (onFeed(r.feed?.status) && BigInt(r.round) > this.postedUpTo) this.postedUpTo = BigInt(r.round);
    let n = 0;
    for (const r of valid) {
      const round = BigInt(r.round);
      if (!done({ round, verdict: r.verdict, feed: r.feed }, this.postedUpTo)) continue;
      if (this.rounds.has(round)) continue;
      this.rounds.set(round, {
        round,
        verdict: r.verdict,
        derived: { status: r.status, openHeight: r.openHeight, closeHeight: r.closeHeight, medians: r.medians ?? [], reportsRoot: r.reportsRoot, leaves: r.leaves ?? [] },
        reports: r.reports ?? [],
        leftOut: r.operator?.leftOut ?? [],
        openPosted: Boolean(r.operator?.openPosted),
        feed: r.feed ?? undefined,
      } as unknown as RoundCheck);
      n++;
    }
    return n;
  }

  status() {
    // Rounds are kept in the order they were first checked; restored ones come first, so sort by number.
    const rounds = [...this.rounds.values()].sort((a, b) => (a.round < b.round ? -1 : a.round > b.round ? 1 : 0));
    const count = (v: string) => rounds.filter((r) => r.verdict === v).length;
    return {
      updatedAt: new Date().toISOString(),
      mode: this.mode,
      rollupId: this.cfg.params.rollupId,
      chainHeight: this.height,
      inboxHead: this.entries.at(-1)?.seq ?? 0n,
      rounds: {
        replayed: rounds.length,
        match: count("match"),
        corrected: count("corrected"),
        medianWrong: count("median-wrong"),
        rootWrong: count("root-wrong"),
        notPosted: count("not-posted"),
        noQuorum: count("no-quorum"),
        unknown: this.unknown.size,
        latest: rounds.at(-1)?.round ?? null,
      },
      batches: {
        replayed: this.batchChecks.length,
        ok: this.batchChecks.filter((b) => b.verdict === "ok").length,
        fraud: this.batchChecks.filter((b) => b.verdict === "fraud").length,
        skipped: this.batchChecks.filter((b) => b.verdict === "skipped").length,
        latestIndex: this.batchChecks.at(-1)?.batchIndex ?? null,
        list: this.batchChecks.slice(-20).map(({ proof, ...b }) => ({ ...b, proofBytes: proof?.length ?? 0 })),
        // Read from the chain's events, so it counts every wrong root ever rejected, by any challenger.
        upheldOnChain: this.upheld.length,
        upheld: this.upheld,
      },
      operatorOmissions: rounds.reduce((n, r) => n + r.leftOut.length, 0),
      challenges: this.challenges,
      latestRounds: rounds.slice(-10).map((r) => ({ round: r.round, verdict: r.verdict, medians: r.derived.medians, reports: r.derived.leaves.length, leftOut: r.leftOut.length, feedStatus: r.feed?.status ?? null })),
    };
  }

  private publishStatus(): void {
    this.feed.status(this.status());
  }

  roundCheck(round: bigint): RoundCheck | undefined {
    return this.rounds.get(round);
  }
}

function roundJson(c: RoundCheck, challenges: Challenge[], domain: Parameters<typeof roundHash>[1]) {
  const d = c.derived;
  const { attestation, anchor, twoSig, ...feed } = c.feed ?? {};
  return {
    round: c.round,
    verdict: c.verdict,
    status: d.status,
    openHeight: d.openHeight,
    closeHeight: d.closeHeight,
    medians: d.medians,
    reportsRoot: d.reportsRoot,
    reports: c.reports,
    leaves: d.leaves,
    outliers: d.outliers.map((l) => l.scout),
    inBand: d.inBand.map((l) => l.scout),
    rejected: d.rejected,
    operator: { openPosted: c.openPosted, leftOut: c.leftOut },
    feed: c.feed ? feed : null,
    challenges,
    // What the operator posted and the anchor of batch `attestation.batchIndex` signs (validator_set_hash slot).
    ...(attestation ? { attestation, roundHash: roundHash(attestation, domain) } : {}),
    // postRound's other arguments, so anyone can repeat PriceFeed.verifyReceipt(attestation, stateRoot, txCount, anchorSig).
    ...(anchor ? { twoSig: twoSig ?? false, stateRoot: anchor.stateRoot, txCount: anchor.txCount, anchorSig: anchor.anchorSig } : {}),
  };
}
