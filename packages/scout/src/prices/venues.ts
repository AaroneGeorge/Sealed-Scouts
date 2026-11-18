// Public, key-free spot tickers. Each venue returns what it quotes; aggregate.ts turns quotes into feed prices.
// Bitstamp and OKX are left out: this server cannot reach them.
import type { GetJson } from "./http.js";
import { toE8 } from "./decimal.js";

export type Asset = "ETH" | "BTC" | "USDC" | "USDT";
export type QuoteCcy = "USD" | "USDT";
export interface Quote { base: Asset; quote: QuoteCcy; price: bigint }

export const VENUE_IDS = ["coinbase", "kraken", "binance", "bybit", "gemini", "kucoin", "gate", "mexc"] as const;
export type VenueId = (typeof VENUE_IDS)[number];

export interface Venue { id: VenueId; read(get: GetJson): Promise<Quote[]> }

type Pair = { base: Asset; quote: QuoteCcy; symbol: string };
const USDT_PAIRS = (fmt: (base: string) => string): Pair[] =>
  (["ETH", "BTC", "USDC"] as const).map((base) => ({ base, quote: "USDT", symbol: fmt(base) }));

function obj(v: unknown, what: string): Record<string, any> {
  if (typeof v !== "object" || v === null) throw new Error(`${what}: unexpected response`);
  return v as Record<string, any>;
}

/** One request per pair. A pair that fails is dropped; the venue fails only when every pair fails. */
async function perPair(get: GetJson, pairs: Pair[], url: (p: Pair) => string, price: (body: unknown) => unknown): Promise<Quote[]> {
  const settled = await Promise.allSettled(pairs.map(async (p) => ({ base: p.base, quote: p.quote, price: toE8(price(await get(url(p)))) })));
  const quotes = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  if (quotes.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
  return quotes;
}

const coinbase: Venue = {
  id: "coinbase",
  // Coinbase has no USDC-USD book (USDC converts 1:1 there), so it gives USDT/USD only.
  read: (get) =>
    perPair(
      get,
      [{ base: "ETH", quote: "USD", symbol: "ETH-USD" }, { base: "BTC", quote: "USD", symbol: "BTC-USD" }, { base: "USDT", quote: "USD", symbol: "USDT-USD" }],
      (p) => `https://api.exchange.coinbase.com/products/${p.symbol}/ticker`,
      (b) => obj(b, "coinbase").price,
    ),
};

const KRAKEN_KEYS: Record<string, Asset> = { XETHZUSD: "ETH", XXBTZUSD: "BTC", USDCUSD: "USDC", USDTZUSD: "USDT" };
const kraken: Venue = {
  id: "kraken",
  async read(get) {
    const body = obj(await get("https://api.kraken.com/0/public/Ticker?pair=ETHUSD,XBTUSD,USDCUSD,USDTUSD"), "kraken");
    if (Array.isArray(body.error) && body.error.length) throw new Error(`kraken: ${body.error.join(", ")}`);
    const result = obj(body.result, "kraken");
    return Object.entries(KRAKEN_KEYS).flatMap(([key, base]) =>
      result[key] ? [{ base, quote: "USD" as const, price: toE8(result[key].c?.[0]) }] : [],
    );
  },
};

const BINANCE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];
const binance: Venue = {
  id: "binance",
  // The market-data mirror is the same exchange, so it is a fallback host, not a second source.
  async read(get) {
    const pairs = USDT_PAIRS((b) => `${b}USDT`);
    const query = encodeURIComponent(JSON.stringify(pairs.map((p) => p.symbol)));
    let last: unknown;
    for (const host of BINANCE_HOSTS) {
      try {
        const rows = await get(`${host}/api/v3/ticker/price?symbols=${query}`);
        if (!Array.isArray(rows)) throw new Error("binance: unexpected response");
        const bySymbol = new Map(rows.map((r) => [r.symbol, r.price]));
        return pairs.flatMap((p) => (bySymbol.has(p.symbol) ? [{ base: p.base, quote: p.quote, price: toE8(bySymbol.get(p.symbol)) }] : []));
      } catch (e) {
        last = e;
      }
    }
    throw last;
  },
};

const bybit: Venue = {
  id: "bybit",
  read: (get) =>
    perPair(get, USDT_PAIRS((b) => `${b}USDT`), (p) => `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${p.symbol}`, (b) => {
      const body = obj(b, "bybit");
      if (body.retCode !== 0) throw new Error(`bybit: ${body.retMsg}`);
      return body.result?.list?.[0]?.lastPrice;
    }),
};

const gemini: Venue = {
  id: "gemini",
  read: (get) =>
    perPair(
      get,
      (["ETH", "BTC", "USDC", "USDT"] as const).map((base) => ({ base, quote: "USD" as const, symbol: `${base.toLowerCase()}usd` })),
      (p) => `https://api.gemini.com/v1/pubticker/${p.symbol}`,
      (b) => obj(b, "gemini").last,
    ),
};

const kucoin: Venue = {
  id: "kucoin",
  read: (get) =>
    perPair(get, USDT_PAIRS((b) => `${b}-USDT`), (p) => `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${p.symbol}`, (b) => {
      const body = obj(b, "kucoin");
      if (body.code !== "200000") throw new Error(`kucoin: code ${body.code}`);
      return body.data?.price;
    }),
};

const gate: Venue = {
  id: "gate",
  read: (get) =>
    perPair(get, USDT_PAIRS((b) => `${b}_USDT`), (p) => `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${p.symbol}`, (b) => {
      if (!Array.isArray(b)) throw new Error("gate: unexpected response");
      return b[0]?.last;
    }),
};

const mexc: Venue = {
  id: "mexc",
  read: (get) =>
    perPair(get, USDT_PAIRS((b) => `${b}USDT`), (p) => `https://api.mexc.com/api/v3/ticker/price?symbol=${p.symbol}`, (b) => obj(b, "mexc").price),
};

export const VENUES: Record<VenueId, Venue> = { coinbase, kraken, binance, bybit, gemini, kucoin, gate, mexc };
