import { describe, expect, it } from "vitest";
import { FEEDS } from "@sealed-scouts/core";
import { aggregate, sourceMedian } from "../src/prices/aggregate.js";
import { formatE8, mulE8, toE8 } from "../src/prices/decimal.js";
import { readPrices, VENUES, VENUE_IDS } from "../src/prices/index.js";
import { VENUE_SETS, SCOUT_ROLES } from "../src/venue-sets.js";
import { recordedGet } from "./helpers.js";

const E8 = 100_000_000n;

describe("decimal prices", () => {
  it("parses exact 8-decimal integers without floats", () => {
    expect(toE8("1753.81")).toBe(175_381_000_000n);
    expect(toE8("62698")).toBe(6_269_800_000_000n);
    expect(toE8("0.99887")).toBe(99_887_000n);
    expect(toE8("1.000940001")).toBe(100_094_000n); // the 9th decimal is cut
  });
  it("refuses zero, negatives and junk instead of guessing", () => {
    for (const bad of ["0", "0.000", "-1", "", "abc", "1e3", undefined, null, {}]) expect(() => toE8(bad)).toThrow();
  });
  it("multiplies and formats", () => {
    expect(mulE8(toE8("1755.72"), toE8("0.99887"))).toBe(175_373_603_640n);
    expect(formatE8(175_381_000_000n)).toBe("1753.81");
    expect(formatE8(E8)).toBe("1");
  });
});

describe("venue adapters (recorded responses)", () => {
  it.each(VENUE_IDS)("%s returns ETH and BTC plus a dollar stablecoin", async (id) => {
    const quotes = await VENUES[id].read(recordedGet());
    const bases = quotes.map((q) => q.base);
    expect(bases).toEqual(expect.arrayContaining(["ETH", "BTC"]));
    expect(bases.some((b) => b === "USDC" || b === "USDT")).toBe(true);
    for (const q of quotes) expect(q.price).toBeGreaterThan(0n);
    const eth = quotes.find((q) => q.base === "ETH")!.price; // USD or USDT: both near the recorded 1,750
    expect(eth).toBeGreaterThan(1_000n * E8);
    expect(eth).toBeLessThan(3_000n * E8);
  });

  it("kraken maps its odd pair names", async () => {
    const quotes = await VENUES.kraken.read(recordedGet());
    expect(quotes.map((q) => `${q.base}/${q.quote}`).sort()).toEqual(["BTC/USD", "ETH/USD", "USDC/USD", "USDT/USD"]);
  });

  it("binance falls back to the market-data host", async () => {
    const primary = recordedGet();
    const get = async (url: string) => {
      if (url.startsWith("https://api.binance.com")) throw new Error("HTTP 451");
      return primary(url.replace("https://data-api.binance.vision", "https://api.binance.com"));
    };
    const quotes = await VENUES.binance.read(get);
    expect(quotes).toHaveLength(3);
  });

  it("a venue with one failed pair keeps the others; with all failed it throws", async () => {
    const some = await VENUES.coinbase.read(recordedGet((u) => u.includes("BTC-USD")));
    expect(some.map((q) => q.base)).toEqual(["ETH", "USDT"]);
    await expect(VENUES.coinbase.read(recordedGet(() => true))).rejects.toThrow(/503/);
  });

  it("an error body is a failure, not a price", async () => {
    await expect(VENUES.kraken.read(async () => ({ error: ["EGeneral:Too many requests"], result: {} }))).rejects.toThrow(/Too many/);
    await expect(VENUES.kucoin.read(async () => ({ code: "429000", data: null }))).rejects.toThrow(/429000/);
    await expect(VENUES.bybit.read(async () => ({ retCode: 10006, retMsg: "rate limit" }))).rejects.toThrow(/rate limit/);
  });
});

describe("aggregate", () => {
  const q = (base: "ETH" | "BTC" | "USDC" | "USDT", quote: "USD" | "USDT", price: string) => ({ base, quote, price: toE8(price) });

  it("source median: middle value, or the floor of the mean of the two middle values", () => {
    expect(sourceMedian([3n, 1n, 2n])).toBe(2n);
    expect(sourceMedian([4n, 1n])).toBe(2n);
    expect(() => sourceMedian([])).toThrow();
  });

  it("converts USDT-quoted prices with the scout's own USDT/USD", () => {
    const { feeds } = aggregate([
      { venue: "coinbase", quotes: [q("ETH", "USD", "1750"), q("USDT", "USD", "0.999")] },
      { venue: "binance", quotes: [q("ETH", "USDT", "1752"), q("USDC", "USDT", "1.001")] },
      { venue: "bybit", quotes: [q("ETH", "USDT", "1760")] },
    ]);
    const eth = feeds.find((f) => f.feedId === FEEDS["fETH/USD"])!;
    // 1750, 1752*0.999 = 1750.248, 1760*0.999 = 1758.24 -> middle 1750.248
    expect(eth.price).toBe(toE8("1750.248"));
    expect(eth.sources).toEqual(["coinbase", "binance", "bybit"]);
    const usd = feeds.find((f) => f.feedId === FEEDS["fUSD/USD"])!;
    // USDC/USD = 1.001*0.999 = 0.999999, USDT/USD = 0.999 -> mean 0.9994995
    expect(usd.price).toBe(toE8("0.9994995"));
    expect(usd.sources.sort()).toEqual(["binance", "coinbase"]);
  });

  it("needs two sources per feed and never fills a gap with zero", () => {
    const { feeds, skipped } = aggregate([
      { venue: "coinbase", quotes: [q("ETH", "USD", "1750"), q("BTC", "USD", "62000"), q("USDT", "USD", "0.999")] },
      { venue: "kraken", quotes: [q("ETH", "USD", "1751")] },
    ]);
    expect(feeds.map((f) => f.feedId)).toEqual([FEEDS["fETH/USD"]]);
    expect(skipped.map((s) => s.feedId).sort()).toEqual([FEEDS["fBTC/USD"], FEEDS["fUSD/USD"]]);
    expect(feeds.every((f) => f.price > 0n)).toBe(true);
  });

  it("without any USDT/USD quote, USDT-quoted venues cannot count", () => {
    const { feeds } = aggregate([
      { venue: "binance", quotes: [q("ETH", "USDT", "1752")] },
      { venue: "bybit", quotes: [q("ETH", "USDT", "1753")] },
    ]);
    expect(feeds).toEqual([]);
  });
});

describe("readPrices for every scout's venue set (recorded responses)", () => {
  it.each(SCOUT_ROLES)("%s gets ETH, BTC and fUSD from its three venues", async (role) => {
    const r = await readPrices(VENUE_SETS[role], recordedGet());
    expect(r.failed).toEqual([]);
    expect(r.feeds.map((f) => f.feedId)).toEqual([1, 2, 3]);
    const usd = r.feeds[2]!.price;
    expect(usd).toBeGreaterThan(99n * E8 / 100n);
    expect(usd).toBeLessThan(101n * E8 / 100n);
  });

  it("every set is different and has a venue that quotes USDT in dollars", () => {
    const keys = SCOUT_ROLES.map((r) => [...VENUE_SETS[r]].sort().join(","));
    expect(new Set(keys).size).toBe(SCOUT_ROLES.length);
    for (const r of SCOUT_ROLES) expect(VENUE_SETS[r].some((v) => ["coinbase", "kraken", "gemini"].includes(v))).toBe(true);
  });

  it("a failed venue is excluded and the scout still reports with two", async () => {
    const r = await readPrices(VENUE_SETS.SCOUT1, recordedGet((u) => u.includes("kraken")));
    expect(r.failed.map((f) => f.venue)).toEqual(["kraken"]);
    expect(r.feeds.find((f) => f.feedId === 1)!.sources).toEqual(["coinbase", "binance"]);
  });
});
