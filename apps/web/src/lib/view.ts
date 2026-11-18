import type { Deployments, FeedMeta, Hex, RoundVerdict, TowerRound, TowerStatus } from "./types";

export const FEEDS: FeedMeta[] = [
  { feedId: 1, symbol: "fETH/USD" },
  { feedId: 2, symbol: "fBTC/USD" },
  { feedId: 3, symbol: "fUSD/USD" },
  { feedId: 4, symbol: "KOCHI-ONION/INR" },
];
export const symbolOf = (feedId: number) => FEEDS.find((f) => f.feedId === feedId)?.symbol ?? `feed ${feedId}`;

/** What a round looks like to a reader: PriceFeed's status when it has one, otherwise what replay found. */
export type DisplayStatus = "sealed" | "not-posted" | "pending" | "final" | "corrected" | "no-quorum";

export function displayStatus(feedStatus: string | null | undefined, verdict: RoundVerdict, opened = true): DisplayStatus {
  if (feedStatus === "pending" || feedStatus === "final" || feedStatus === "corrected") return feedStatus;
  if (verdict === "no-quorum") return "no-quorum";
  return opened ? "not-posted" : "sealed";
}

export const roundStatus = (r: TowerRound): DisplayStatus =>
  displayStatus(r.feed?.status, r.verdict, r.leaves.length > 0 || r.reports.length === 0);

/** One line on what the watchtower concluded, and whether it is good news. */
export const VERDICT: Record<RoundVerdict, { text: string; tone: "pass" | "fail" | "sealed" | "wait" }> = {
  match: { text: "replay matches the feed", tone: "pass" },
  "median-wrong": { text: "wrong median: challengeable", tone: "fail" },
  "root-wrong": { text: "report set differs: flagged", tone: "fail" },
  corrected: { text: "corrected by the court", tone: "sealed" },
  "not-posted": { text: "derived, not posted yet", tone: "wait" },
  "no-quorum": { text: "too few valid reports", tone: "wait" },
};

/** Latest settled medians per feed: newest round that is final or corrected and that replay agrees with. */
export function latestPrices(s: TowerStatus) {
  const settled = [...s.latestRounds].reverse().find((r) => (r.feedStatus === "final" || r.feedStatus === "corrected") && (r.verdict === "match" || r.verdict === "corrected"));
  if (!settled) return [];
  const status = settled.feedStatus === "corrected" ? "corrected" : "final";
  return settled.medians.map((m) => ({ ...m, round: settled.round, status } as const));
}

/** The simulated demo history (`--fixture demo`) runs on a rollup id ending in "-sim". */
export const isSample = (s: TowerStatus | undefined) => !!s && s.rollupId.endsWith("-sim");

export const contractsOf = (d: Deployments | undefined) => ({
  priceFeed: (d?.contracts?.PriceFeed ?? d?.priceFeed ?? null) as Hex | null,
  scoutLend: (d?.contracts?.ScoutLend ?? d?.scoutLend ?? null) as Hex | null,
});
