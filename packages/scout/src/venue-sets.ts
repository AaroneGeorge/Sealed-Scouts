// Each scout reads a different set of three venues, so honest reports differ a little and a copied report shows.
// Every set holds at least one venue that quotes USDT against real dollars (Coinbase, Kraken or Gemini),
// which the scout needs to convert USDT-quoted prices.
import type { VenueId } from "./prices/index.js";

export const SCOUT_ROLES = ["SCOUT1", "SCOUT2", "SCOUT3", "SCOUT4", "SCOUT5"] as const;
export type ScoutRole = (typeof SCOUT_ROLES)[number];

export const VENUE_SETS: Record<ScoutRole, readonly [VenueId, VenueId, VenueId]> = {
  SCOUT1: ["coinbase", "kraken", "binance"],
  SCOUT2: ["kraken", "bybit", "kucoin"],
  SCOUT3: ["gemini", "gate", "mexc"],
  SCOUT4: ["coinbase", "kucoin", "gate"],
  SCOUT5: ["gemini", "binance", "bybit"],
};

export function isScoutRole(s: string): s is ScoutRole {
  return (SCOUT_ROLES as readonly string[]).includes(s);
}
