// Turn one scout's venue quotes into its own price per feed. Each feed needs at least MIN_SOURCES venues;
// a venue that failed is simply absent, never counted as a zero.
import { FEEDS } from "@sealed-scouts/core";
import { mulE8 } from "./decimal.js";
import type { Asset, Quote, VenueId } from "./venues.js";

export const MIN_SOURCES = 2;

export interface VenueQuotes { venue: VenueId; quotes: Quote[] }
export interface FeedPrice { feedId: number; price: bigint; sources: VenueId[] }
export interface Skipped { feedId: number; reason: string }

/** The scout's own median: the middle value, or the floor of the mean of the two middle values. */
export function sourceMedian(values: bigint[]): bigint {
  if (values.length === 0) throw new Error("median of nothing");
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

type Sample = { venue: VenueId; usd: bigint };

export function aggregate(results: VenueQuotes[]): { feeds: FeedPrice[]; skipped: Skipped[] } {
  // USDT/USD comes only from venues that quote it against real dollars; it converts every USDT-quoted price.
  const usdtDirect = results.flatMap((r) => r.quotes.filter((q) => q.base === "USDT" && q.quote === "USD").map((q) => q.price));
  const usdtUsd = usdtDirect.length ? sourceMedian(usdtDirect) : undefined;

  const samples = (asset: Asset): Sample[] =>
    results.flatMap((r) =>
      r.quotes
        .filter((q) => q.base === asset)
        .flatMap((q) => {
          if (q.quote === "USD") return [{ venue: r.venue, usd: q.price }];
          return usdtUsd === undefined ? [] : [{ venue: r.venue, usd: mulE8(q.price, usdtUsd) }];
        }),
    );

  const feeds: FeedPrice[] = [];
  const skipped: Skipped[] = [];
  const add = (feedId: number, picked: Sample[], price: () => bigint) => {
    const sources = [...new Set(picked.map((s) => s.venue))];
    if (sources.length < MIN_SOURCES) skipped.push({ feedId, reason: `${sources.length} source(s), need ${MIN_SOURCES}` });
    else feeds.push({ feedId, price: price(), sources });
  };

  for (const [feedId, asset] of [[FEEDS["fETH/USD"], "ETH"], [FEEDS["fBTC/USD"], "BTC"]] as const) {
    const s = samples(asset);
    add(feedId, s, () => sourceMedian(s.map((x) => x.usd)));
  }

  // fUSD tracks the two big dollar stablecoins: the mean of the USDC/USD and USDT/USD medians.
  const usdc = samples("USDC");
  const usdt = samples("USDT");
  if (usdc.length === 0 || usdt.length === 0) skipped.push({ feedId: FEEDS["fUSD/USD"], reason: "needs both USDC/USD and USDT/USD" });
  else add(FEEDS["fUSD/USD"], [...usdc, ...usdt], () => (sourceMedian(usdc.map((x) => x.usd)) + sourceMedian(usdt.map((x) => x.usd))) / 2n);

  return { feeds, skipped };
}
