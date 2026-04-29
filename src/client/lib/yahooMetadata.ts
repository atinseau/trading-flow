import { childLogger } from "@client/lib/logger";

const log = childLogger({ module: "yahoo-metadata" });
const USER_AGENT =
  "Mozilla/5.0 (compatible; trading-flow/1.0; +https://github.com/atinseau/trading-flow)";

export type YahooMetadata = {
  quoteType: "EQUITY" | "ETF" | "INDEX" | "CURRENCY" | "FUTURE" | "CRYPTOCURRENCY";
  /** Raw Yahoo exchange code (e.g. "NMS", "NYQ", "PAR"). Undefined when irrelevant (forex). */
  exchange?: string;
};

const ALLOWED: ReadonlyArray<YahooMetadata["quoteType"]> = [
  "EQUITY",
  "ETF",
  "INDEX",
  "CURRENCY",
  "FUTURE",
  "CRYPTOCURRENCY",
];

/**
 * Exact-match Yahoo metadata lookup for a symbol. Returns null on miss or
 * unsupported quoteType (which keeps callers safe — they can 422).
 */
export async function lookupYahooMetadata(symbol: string): Promise<YahooMetadata | null> {
  const url = new URL("https://query1.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", symbol);
  url.searchParams.set("quotesCount", "10");
  url.searchParams.set("newsCount", "0");
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  } catch (e) {
    log.warn({ symbol, err: (e as Error).message }, "yahoo metadata fetch threw");
    return null;
  }
  if (!res.ok) {
    log.warn({ symbol, status: res.status }, "yahoo metadata lookup failed");
    return null;
  }
  const json = (await res.json()) as {
    quotes?: Array<{ symbol: string; quoteType?: string; exchange?: string }>;
  };
  const exact = (json.quotes ?? []).find((q) => q.symbol === symbol);
  if (!exact?.quoteType) return null;
  if (!ALLOWED.includes(exact.quoteType as YahooMetadata["quoteType"])) return null;
  return {
    quoteType: exact.quoteType as YahooMetadata["quoteType"],
    exchange: exact.exchange,
  };
}
