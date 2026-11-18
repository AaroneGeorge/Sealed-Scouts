// Replay one round from inbox data and judge what the operator did with it: its OPEN and the round it
// posted to PriceFeed. Pure: the same entries always give the same verdict.
import {
  REJECT, decodeMsg, deriveRound, roundWindows, scoutAddress, type InboxEntry, type RoundParams, type RoundResult,
} from "@sealed-scouts/core";

/** A round as PriceFeed holds it. */
export interface FeedRound {
  status: "none" | "pending" | "final" | "corrected";
  feedIds: number[];
  medians: bigint[];
  counts: number[];
  reportsRoot: `0x${string}`;
  reportCount: number;
  batchIndex: bigint;
}

export type RoundVerdict =
  | "match" // the feed holds exactly what replay derives
  | "median-wrong" // same reports, wrong median or count: the court can correct it and slash
  | "root-wrong" // the operator committed a different report set: flagged, not slashable in v1 (LIMITS L4, L5)
  | "corrected" // the court already replaced the operator's median
  | "not-posted" // derived, but nothing on the feed yet
  | "no-quorum"; // no feed reached quorum: nothing to post

export interface RoundCheck {
  round: bigint;
  verdict: RoundVerdict;
  derived: RoundResult;
  /** Sealed report tiles: who posted, sizes and heights; prices only once opened. */
  reports: { scout: string; reportBytes: number; commitBytes: number; height: bigint; counted: boolean; prices?: { feedId: number; price: bigint }[] }[];
  /** Valid commitments the operator's OPEN did not open (counted through REVEAL, or lost). */
  leftOut: { scout: string; how: "revealed" | "lost" }[];
  openPosted: boolean;
  feed?: FeedRound;
}

const LOST: readonly string[] = [REJECT.notOpened, REJECT.openingMismatch, REJECT.revealOutsideWindow];

/** Does the feed's round equal the derived round? Same reports root, count, feeds and medians. */
function sameAsFeed(d: RoundResult, f: FeedRound): { root: boolean; medians: boolean } {
  const root = f.reportsRoot.toLowerCase() === d.reportsRoot.toLowerCase() && f.reportCount === d.leaves.length;
  const medians =
    f.feedIds.length === d.medians.length &&
    d.medians.every((m, i) => f.feedIds[i] === m.feedId && f.medians[i] === m.price && f.counts[i] === m.count);
  return { root, medians };
}

export function checkRound(entries: InboxEntry[], round: bigint, params: RoundParams, eligible: (scout: string, round: bigint) => boolean, feed?: FeedRound): RoundCheck {
  const derived = deriveRound(entries, round, params, eligible);
  const w = roundWindows(round, params);

  const posts = new Map<string, { report?: InboxEntry; commit?: InboxEntry }>();
  let openPosted = false;
  for (const e of entries) {
    const m = decodeMsg(e.payload);
    if (!m || m.kind === "JOIN" || m.round !== round) continue;
    if (m.kind === "OPEN" && e.poster === params.operator && e.height >= w.commitEnd && e.height < w.openEnd) openPosted = true;
    if (m.kind === "REPORT" || m.kind === "COMMIT") {
      const p = posts.get(e.poster) ?? {};
      p[m.kind === "REPORT" ? "report" : "commit"] ??= e;
      posts.set(e.poster, p);
    }
  }
  const leafOf = new Map(derived.leaves.map((l) => [l.scout.toLowerCase(), l]));
  const reports = [...posts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([scout, p]) => {
    const leaf = leafOf.get(scoutAddress(scout) ?? "");
    return {
      scout,
      reportBytes: p.report?.payload.length ?? 0,
      commitBytes: p.commit?.payload.length ?? 0,
      height: p.report?.height ?? p.commit?.height ?? 0n,
      counted: Boolean(leaf),
      prices: leaf?.feedIds.map((feedId, i) => ({ feedId, price: leaf.prices[i]! })),
    };
  });

  const leftOut = [
    ...derived.skippedByOpener.map((scout) => ({ scout, how: "revealed" as const })),
    ...derived.rejected.filter((r) => LOST.includes(r.reason)).map((r) => ({ scout: r.scout, how: "lost" as const })),
  ];

  let verdict: RoundVerdict;
  if (feed && feed.status !== "none") {
    const same = sameAsFeed(derived, feed);
    verdict = !same.root ? "root-wrong" : !same.medians ? "median-wrong" : feed.status === "corrected" ? "corrected" : "match";
  } else verdict = derived.status === "no-quorum" ? "no-quorum" : "not-posted";
  return { round, verdict, derived, reports, leftOut, openPosted, feed };
}
