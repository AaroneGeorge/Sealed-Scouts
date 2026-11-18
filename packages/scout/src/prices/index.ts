// Read one scout's venues and return its own price per feed.
import { aggregate, type FeedPrice, type Skipped, type VenueQuotes } from "./aggregate.js";
import type { GetJson } from "./http.js";
import { VENUES, type VenueId } from "./venues.js";

export interface PriceReading { feeds: FeedPrice[]; skipped: Skipped[]; failed: { venue: VenueId; error: string }[]; venues: VenueQuotes[] }

export async function readPrices(venueIds: readonly VenueId[], get: GetJson): Promise<PriceReading> {
  const settled = await Promise.allSettled(venueIds.map(async (id) => ({ venue: id, quotes: await VENUES[id].read(get) })));
  const venues: VenueQuotes[] = [];
  const failed: PriceReading["failed"] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") venues.push(s.value);
    else failed.push({ venue: venueIds[i]!, error: s.reason instanceof Error ? s.reason.message : String(s.reason) });
  });
  return { ...aggregate(venues), failed, venues };
}

export { sourceMedian, MIN_SOURCES, type FeedPrice } from "./aggregate.js";
export { formatE8, toE8 } from "./decimal.js";
export { politeGetJson, USER_AGENT, type GetJson } from "./http.js";
export { VENUES, VENUE_IDS, type VenueId, type Quote } from "./venues.js";
