// deriveRound: the one pure function that turns a round's inbox entries into its result.
// The operator and every watchtower run it on the same entries and must get identical output.
import { scoutAddress } from "./address.js";
import { bytesEqual, type Hex } from "./bytes.js";
import { decodeMsg, type CommitMsg, type PriceSet } from "./codec.js";
import { commitSigHash, commitment, verifyCommit } from "./commit.js";
import { reportsRoot, sortLeaves, type Leaf } from "./leaf.js";
import { isInBand, isOutlier, median } from "./median.js";
import { roundWindows, type RoundTiming } from "./round.js";

export interface InboxEntry { seq: bigint; height: bigint; poster: string; payload: Uint8Array }

export interface RoundRules {
  /** Reports a feed needs before it gets a median. */
  quorum: number;
  /** In band (rewarded): within this many basis points of the median. */
  bandBps: number;
  /** Outlier (slashable): beyond this many basis points of the median. */
  slashBps: number;
}

export const DEFAULT_RULES: RoundRules = { quorum: 3, bandBps: 200, slashBps: 1000 };

export interface RoundParams extends RoundTiming, RoundRules {
  /** Cosmos chain id the COMMIT signatures are bound to, e.g. "qorechain-diana". */
  chainId: string;
  rollupId: string;
  /** qor1 account allowed to post OPEN (the opener). */
  operator: string;
  /** Registered ML-DSA-87 public key of a scout (qor1), or undefined if none. */
  pqKeyOf: (scout: string) => Uint8Array | undefined;
}

export interface FeedMedian { feedId: number; price: bigint; count: number }

export interface RoundResult {
  round: bigint;
  status: "ok" | "no-quorum";
  /** Counted reports, sorted by scout address (tree order). */
  leaves: Leaf[];
  /** Feeds that reached quorum, ascending feed id. Empty when status is "no-quorum". */
  medians: FeedMedian[];
  reportsRoot: Hex;
  /** Leaves beyond slashBps of a median on any feed. */
  outliers: Leaf[];
  /** Leaves within bandBps of the median on every feed that has one. */
  inBand: Leaf[];
  /** Why each other scout (or a bad OPEN poster) did not count. Sorted by scout, then reason. */
  rejected: { scout: string; reason: RejectReason }[];
  /** Scouts (qor1) that counted only through their own REVEAL: the opener skipped or mis-opened them. */
  skippedByOpener: string[];
  /** First block of the round. */
  openHeight: bigint;
  /** First block after the commit window. */
  closeHeight: bigint;
}

export const REJECT = {
  duplicateCommit: "duplicate-commit",
  duplicateReport: "duplicate-report",
  missingCommit: "missing-commit",
  missingReport: "missing-report",
  outsideCommitWindow: "outside-commit-window",
  badAddress: "bad-address",
  notEligible: "not-eligible",
  noPqKey: "no-pq-key",
  badSignature: "bad-signature",
  notOpened: "not-opened",
  openingMismatch: "opening-mismatch",
  revealOutsideWindow: "reveal-outside-window",
  badPrices: "bad-prices",
  openNotOperator: "open-not-operator",
  openOutsideWindow: "open-outside-window",
} as const;
export type RejectReason = (typeof REJECT)[keyof typeof REJECT];

type Opening = { salt: Uint8Array; viaReveal: boolean } & PriceSet;

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => void (m.get(k) ?? m.set(k, []).get(k)!).push(v);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** feedIds strictly ascending, at least one feed, every price above zero. */
function validPrices(p: PriceSet): boolean {
  if (p.feedIds.length === 0) return false;
  return p.feedIds.every((id, i) => (i === 0 || id > p.feedIds[i - 1]!) && p.prices[i]! > 0n);
}

export function deriveRound(
  entries: InboxEntry[],
  round: bigint,
  params: RoundParams,
  eligible: (scout: string, round: bigint) => boolean,
): RoundResult {
  const w = roundWindows(round, params);
  const inCommit = (h: bigint) => h >= w.start && h < w.commitEnd;
  const inOpen = (h: bigint) => h >= w.commitEnd && h < w.openEnd;
  const inReveal = (h: bigint) => h >= w.commitEnd && h < w.revealEnd;

  const reports = new Map<string, InboxEntry[]>();
  const commits = new Map<string, { e: InboxEntry; m: CommitMsg }[]>();
  const opened = new Map<string, Opening[]>(); // by scout 0x address
  const reveals = new Map<string, Opening[]>(); // by poster
  const lateReveals = new Set<string>();
  const rejected: RoundResult["rejected"] = [];

  for (const e of [...entries].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))) {
    const m = decodeMsg(e.payload);
    if (!m || m.kind === "JOIN" || m.round !== round) continue;
    if (m.kind === "REPORT") push(reports, e.poster, e);
    else if (m.kind === "COMMIT") push(commits, e.poster, { e, m });
    else if (m.kind === "REVEAL") {
      if (inReveal(e.height)) push(reveals, e.poster, { ...m, viaReveal: true });
      else lateReveals.add(e.poster);
    } else if (e.poster !== params.operator) rejected.push({ scout: e.poster, reason: REJECT.openNotOperator });
    else if (!inOpen(e.height)) rejected.push({ scout: e.poster, reason: REJECT.openOutsideWindow });
    else for (const o of m.openings) push(opened, o.scout.toLowerCase(), { ...o, viaReveal: false });
  }

  const leaves: Leaf[] = [];
  const skippedByOpener: string[] = [];
  const scouts = [...new Set([...reports.keys(), ...commits.keys()])].sort(cmp);
  for (const poster of scouts) {
    const reject = (reason: RejectReason) => void rejected.push({ scout: poster, reason });
    const r = reports.get(poster) ?? [];
    const c = commits.get(poster) ?? [];
    if (c.length > 1) { reject(REJECT.duplicateCommit); continue; }
    if (r.length > 1) { reject(REJECT.duplicateReport); continue; }
    if (c.length === 0) { reject(REJECT.missingCommit); continue; }
    if (r.length === 0) { reject(REJECT.missingReport); continue; }
    const { e: commitEntry, m: commit } = c[0]!;
    if (!inCommit(r[0]!.height) || !inCommit(commitEntry.height)) { reject(REJECT.outsideCommitWindow); continue; }
    const scout = scoutAddress(poster);
    if (!scout) { reject(REJECT.badAddress); continue; }
    if (!eligible(poster, round)) { reject(REJECT.notEligible); continue; }
    const key = params.pqKeyOf(poster);
    if (!key) { reject(REJECT.noPqKey); continue; }
    const ctx = { chainId: params.chainId, rollupId: params.rollupId, round, scout: poster, commitment: commit.commitment };
    if (!verifyCommit(key, ctx, commit.signature)) { reject(REJECT.badSignature); continue; }

    // The operator's opening first, then the scout's own reveal. The commitment binds both, so any match is the report.
    const candidates = [...(opened.get(scout) ?? []), ...(reveals.get(poster) ?? [])];
    const match = candidates.find((o) => bytesEqual(commitment(round, scout, o.salt, o), commit.commitment));
    if (!match) {
      reject(candidates.length > 0 ? REJECT.openingMismatch : lateReveals.has(poster) ? REJECT.revealOutsideWindow : REJECT.notOpened);
      continue;
    }
    if (!validPrices(match)) { reject(REJECT.badPrices); continue; }
    if (match.viaReveal) skippedByOpener.push(poster);
    leaves.push({ round, scout, salt: match.salt, feedIds: match.feedIds, prices: match.prices, commitSigHash: commitSigHash(commit.signature) });
  }

  const sorted = sortLeaves(leaves);
  const medians = feedMedians(sorted, params.quorum);
  const priceOn = (l: Leaf, feedId: number) => l.prices[l.feedIds.indexOf(feedId)];
  const judged = (l: Leaf) => medians.filter((m) => l.feedIds.includes(m.feedId));
  return {
    round,
    status: medians.length > 0 ? "ok" : "no-quorum",
    leaves: sorted,
    medians,
    reportsRoot: reportsRoot(sorted),
    outliers: sorted.filter((l) => judged(l).some((m) => isOutlier(priceOn(l, m.feedId)!, m.price, params.slashBps))),
    inBand: sorted.filter((l) => judged(l).length > 0 && judged(l).every((m) => isInBand(priceOn(l, m.feedId)!, m.price, params.bandBps))),
    rejected: rejected.sort((a, b) => cmp(a.scout, b.scout) || cmp(a.reason, b.reason)),
    skippedByOpener,
    openHeight: w.start,
    closeHeight: w.commitEnd,
  };
}

/** Median per feed over the counted leaves, only for feeds with at least `quorum` reports. */
export function feedMedians(leaves: Leaf[], quorum: number): FeedMedian[] {
  const byFeed = new Map<number, bigint[]>();
  for (const l of leaves) l.feedIds.forEach((id, i) => push(byFeed, id, l.prices[i]!));
  return [...byFeed.entries()]
    .filter(([, prices]) => prices.length >= quorum)
    .sort(([a], [b]) => a - b)
    .map(([feedId, prices]) => ({ feedId, price: median(prices), count: prices.length }));
}
