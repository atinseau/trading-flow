import { TTLCache } from "./cache";
import { childLogger } from "./logger";

const log = childLogger({ module: "market-data" });

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export type AssetType =
  | "crypto"
  | "stock"
  | "index"
  | "etf"
  | "currency"
  | "future"
  | "other";

export type SearchResult = {
  symbol: string;
  name: string;
  source: "binance" | "yahoo";
  type: AssetType;
  exchange?: string;
  /** Higher = more relevant. Used for cross-source ranking. */
  score: number;
};

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

/* ============================================================
 *  Caches
 * ============================================================ */

// 5 min — search results refresh fast enough for new tickers
const searchCache = new TTLCache<SearchResult[]>(5 * 60_000);
// 24 h — Binance pairs change rarely
const binanceSymbolsCache = new TTLCache<BinanceSymbol[]>(24 * 60 * 60_000);
// OHLCV cached per (source, symbol, interval). TTL = interval / 4 to feel fresh.
const ohlcvCache = new TTLCache<Candle[]>(60_000); // default 1 min, callers pass per-interval TTL

/* ============================================================
 *  Yahoo
 * ============================================================ */

type YahooQuote = {
  symbol: string;
  shortname?: string;
  longname?: string;
  quoteType: string;
  exchange?: string;
  exchDisp?: string;
  score?: number;
};

const yahooTypeMap: Record<string, AssetType> = {
  EQUITY: "stock",
  CRYPTOCURRENCY: "crypto",
  ETF: "etf",
  INDEX: "index",
  CURRENCY: "currency",
  FUTURE: "future",
};

async function yahooSearch(query: string): Promise<SearchResult[]> {
  const url = new URL("https://query1.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", query);
  url.searchParams.set("quotesCount", "20");
  url.searchParams.set("newsCount", "0");

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    log.warn({ status: res.status, query }, "yahoo search failed");
    return [];
  }
  const json = (await res.json()) as { quotes?: YahooQuote[] };
  return (json.quotes ?? []).map((q) => ({
    symbol: q.symbol,
    name: q.longname ?? q.shortname ?? q.symbol,
    source: "yahoo" as const,
    type: yahooTypeMap[q.quoteType] ?? "other",
    exchange: q.exchDisp ?? q.exchange,
    score: q.score ?? 0,
  }));
}

/* ============================================================
 *  Binance
 * ============================================================ */

type BinanceSymbol = {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
};

async function fetchBinanceSymbols(): Promise<BinanceSymbol[]> {
  const res = await fetch("https://api.binance.com/api/v3/exchangeInfo", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    log.warn({ status: res.status }, "binance exchangeInfo failed");
    return [];
  }
  const json = (await res.json()) as { symbols: BinanceSymbol[] };
  // Only keep TRADING pairs to avoid stale / delisted clutter
  return json.symbols.filter((s) => s.status === "TRADING");
}

async function binanceSearch(query: string): Promise<SearchResult[]> {
  const symbols = await binanceSymbolsCache.getOrFetch("all", fetchBinanceSymbols);
  const q = query.toUpperCase();
  const matches: SearchResult[] = [];
  for (const s of symbols) {
    const symbolMatch = s.symbol.includes(q);
    const baseMatch = s.baseAsset === q;
    if (!symbolMatch && !baseMatch) continue;

    // Score: exact symbol match > exact base match > prefix match > substring match
    let score = 100;
    if (s.symbol === q) score = 1000;
    else if (s.baseAsset === q) score = 800;
    else if (s.symbol.startsWith(q)) score = 500;
    matches.push({
      symbol: s.symbol,
      name: `${s.baseAsset} / ${s.quoteAsset}`,
      source: "binance",
      type: "crypto",
      exchange: "Binance",
      score,
    });
    if (matches.length >= 30) break; // cap to avoid huge payloads on common queries
  }
  return matches;
}

/* ============================================================
 *  Combined search
 * ============================================================ */

export async function searchAssets(input: { query: string; types?: AssetType[] }): Promise<SearchResult[]> {
  const cacheKey = `${input.query.toLowerCase()}|${(input.types ?? []).sort().join(",")}`;
  return searchCache.getOrFetch(cacheKey, async () => {
    const [yahoo, binance] = await Promise.all([
      yahooSearch(input.query),
      binanceSearch(input.query),
    ]);
    let merged = [...yahoo, ...binance];
    if (input.types && input.types.length > 0) {
      merged = merged.filter((r) => input.types!.includes(r.type));
    }
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, 50);
  });
}

/* ============================================================
 *  OHLCV (proxied + cached)
 * ============================================================ */

const BINANCE_INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

const YAHOO_INTERVAL_MAP: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "60m",
  "1d": "1d",
  "1w": "1wk",
};

async function binanceOhlcv(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(Math.min(limit, 1000)));

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Binance klines ${symbol} ${interval}: ${res.status}`);
  // Binance returns [openTime, open, high, low, close, volume, ...]
  const rows = (await res.json()) as [number, string, string, string, string, string, ...unknown[]][];
  return rows.map((r) => ({
    time: Math.floor(r[0] / 1000),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));
}

async function yahooOhlcv(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const yInterval = YAHOO_INTERVAL_MAP[interval] ?? "1d";
  // Yahoo expects a range; pick a range proportional to limit + interval
  const range = (() => {
    if (interval === "1m" || interval === "5m") return "5d";
    if (interval === "15m" || interval === "30m") return "1mo";
    if (interval === "1h") return "3mo";
    if (interval === "1d") return "1y";
    if (interval === "1w") return "5y";
    return "1y";
  })();

  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("interval", yInterval);
  url.searchParams.set("range", range);

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Yahoo chart ${symbol} ${interval}: ${res.status}`);
  type YahooResp = {
    chart: {
      result: [
        {
          timestamp: number[];
          indicators: {
            quote: [{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }];
          };
        },
      ];
    };
  };
  const json = (await res.json()) as YahooResp;
  const r = json.chart?.result?.[0];
  if (!r) return [];
  const q = r.indicators.quote[0];
  const out: Candle[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.open[i] == null) continue; // Yahoo nullifies missing bars
    out.push({
      time: r.timestamp[i]!,
      open: q.open[i]!,
      high: q.high[i]!,
      low: q.low[i]!,
      close: q.close[i]!,
      volume: q.volume[i] ?? 0,
    });
  }
  return out.slice(-limit);
}

export async function fetchOhlcv(input: {
  source: "binance" | "yahoo";
  symbol: string;
  interval: string;
  limit?: number;
}): Promise<Candle[]> {
  const limit = input.limit ?? 200;
  const key = `${input.source}|${input.symbol}|${input.interval}|${limit}`;
  // TTL = quarter of the candle interval (e.g. 15min for 1h, 15s for 1m)
  // Min 5s, max 5 min — keeps things fresh without hammering APIs.
  const intervalMs = BINANCE_INTERVAL_MS[input.interval] ?? 60_000;
  const ttl = Math.max(5_000, Math.min(5 * 60_000, intervalMs / 4));
  return ohlcvCache.getOrFetch(
    key,
    () => (input.source === "binance"
      ? binanceOhlcv(input.symbol, input.interval, limit)
      : yahooOhlcv(input.symbol, input.interval, limit)),
    ttl,
  );
}
