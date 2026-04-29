import { AssetNotFoundError, ExchangeRateLimitError } from "@domain/errors";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Candle } from "@domain/schemas/Candle";
import { CandleSchema } from "@domain/schemas/Candle";
import { getLogger } from "@observability/logger";
import { z } from "zod";

const log = getLogger({ component: "binance-fetcher" });

const BINANCE_BASE_URL = "https://api.binance.com";
const BINANCE_KLINE_PAGE_SIZE = 1000;

const TIMEFRAME_MAP: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "1d": "1d",
  "1w": "1w",
};

const KlineRowSchema = z.tuple([
  z.number(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.number(),
  z.string(),
  z.number(),
  z.string(),
  z.string(),
  z.string(),
]);
const KlineArraySchema = z.array(KlineRowSchema);

const ExchangeInfoSchema = z.object({
  symbols: z.array(z.object({ symbol: z.string(), status: z.string() })),
});

export class BinanceFetcher implements MarketDataFetcher {
  readonly source = "binance";
  private supportedSymbolsCache: { data: Set<string>; expiresAt: number } | null = null;

  async fetchOHLCV(args: {
    asset: string;
    timeframe: string;
    limit: number;
    endTime?: Date;
  }): Promise<Candle[]> {
    const interval = TIMEFRAME_MAP[args.timeframe];
    if (!interval) throw new Error(`Timeframe non supporté: ${args.timeframe}`);

    const url = new URL(`${BINANCE_BASE_URL}/api/v3/klines`);
    url.searchParams.set("symbol", args.asset);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(args.limit));
    if (args.endTime) url.searchParams.set("endTime", String(args.endTime.getTime()));

    const response = await fetch(url);
    if (response.status === 418 || response.status === 429) {
      log.warn({ asset: args.asset, status: response.status }, "binance rate limited");
      throw new ExchangeRateLimitError(`Binance rate limited: ${response.status}`);
    }
    if (response.status === 400) {
      const body = await response.text();
      if (body.includes("Invalid symbol")) {
        log.error({ asset: args.asset }, "binance asset not found");
        throw new AssetNotFoundError(args.asset);
      }
      log.error({ asset: args.asset, body }, "binance 400");
      throw new Error(`Binance 400: ${body}`);
    }
    if (!response.ok) {
      const body = await response.text();
      log.error({ asset: args.asset, status: response.status }, "binance fetch failed");
      throw new Error(`Binance ${response.status}: ${body}`);
    }

    const raw = await response.json();
    const rows = KlineArraySchema.parse(raw);
    return rows.map((row) =>
      CandleSchema.parse({
        timestamp: new Date(row[0]),
        open: Number.parseFloat(row[1]),
        high: Number.parseFloat(row[2]),
        low: Number.parseFloat(row[3]),
        close: Number.parseFloat(row[4]),
        volume: Number.parseFloat(row[5]),
      }),
    );
  }

  async fetchRange(args: {
    asset: string;
    timeframe: string;
    from: Date;
    to: Date;
  }): Promise<Candle[]> {
    const interval = TIMEFRAME_MAP[args.timeframe];
    if (!interval) throw new Error(`Timeframe non supporté: ${args.timeframe}`);

    const all: Candle[] = [];
    const toMs = args.to.getTime();
    let cursor = args.from.getTime();
    while (cursor <= toMs) {
      const batch = await this.fetchBatch({
        asset: args.asset,
        interval,
        startTime: cursor,
        endTime: toMs,
        limit: BINANCE_KLINE_PAGE_SIZE,
      });
      if (batch.length === 0) break;
      all.push(...batch);
      if (batch.length < BINANCE_KLINE_PAGE_SIZE) break;
      const lastTs = batch[batch.length - 1]!.timestamp.getTime();
      // Safety: if the cursor wouldn't advance, stop to avoid infinite loop.
      if (lastTs <= cursor) break;
      cursor = lastTs + 1;
    }
    return all;
  }

  private async fetchBatch(args: {
    asset: string;
    interval: string;
    startTime: number;
    endTime: number;
    limit: number;
  }): Promise<Candle[]> {
    const url = new URL(`${BINANCE_BASE_URL}/api/v3/klines`);
    url.searchParams.set("symbol", args.asset);
    url.searchParams.set("interval", args.interval);
    url.searchParams.set("startTime", String(args.startTime));
    url.searchParams.set("endTime", String(args.endTime));
    url.searchParams.set("limit", String(args.limit));

    const response = await fetch(url);
    if (response.status === 418 || response.status === 429) {
      log.warn({ asset: args.asset, status: response.status }, "binance rate limited");
      throw new ExchangeRateLimitError(`Binance rate limited: ${response.status}`);
    }
    if (response.status === 400) {
      const body = await response.text();
      if (body.includes("Invalid symbol")) {
        log.error({ asset: args.asset }, "binance asset not found");
        throw new AssetNotFoundError(args.asset);
      }
      log.error({ asset: args.asset, body }, "binance 400");
      throw new Error(`Binance 400: ${body}`);
    }
    if (!response.ok) {
      const body = await response.text();
      log.error({ asset: args.asset, status: response.status }, "binance fetch failed");
      throw new Error(`Binance ${response.status}: ${body}`);
    }

    const raw = await response.json();
    const rows = KlineArraySchema.parse(raw);
    return rows.map((row) =>
      CandleSchema.parse({
        timestamp: new Date(row[0]),
        open: Number.parseFloat(row[1]),
        high: Number.parseFloat(row[2]),
        low: Number.parseFloat(row[3]),
        close: Number.parseFloat(row[4]),
        volume: Number.parseFloat(row[5]),
      }),
    );
  }

  async isAssetSupported(asset: string): Promise<boolean> {
    const now = Date.now();
    if (!this.supportedSymbolsCache || this.supportedSymbolsCache.expiresAt < now) {
      const url = `${BINANCE_BASE_URL}/api/v3/exchangeInfo`;
      const response = await fetch(url);
      if (!response.ok) return false;
      const data = ExchangeInfoSchema.parse(await response.json());
      this.supportedSymbolsCache = {
        data: new Set(data.symbols.filter((s) => s.status === "TRADING").map((s) => s.symbol)),
        expiresAt: now + 3600_000,
      };
    }
    return this.supportedSymbolsCache.data.has(asset);
  }
}
