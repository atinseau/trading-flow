import { AssetNotFoundError, ExchangeRateLimitError } from "@domain/errors";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Candle } from "@domain/schemas/Candle";
import { CandleSchema } from "@domain/schemas/Candle";
import { z } from "zod";

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

  constructor(private config: { baseUrl?: string }) {}

  async fetchOHLCV(args: {
    asset: string;
    timeframe: string;
    limit: number;
    endTime?: Date;
  }): Promise<Candle[]> {
    const interval = TIMEFRAME_MAP[args.timeframe];
    if (!interval) throw new Error(`Timeframe non supporté: ${args.timeframe}`);

    const url = new URL(`${this.config.baseUrl ?? "https://api.binance.com"}/api/v3/klines`);
    url.searchParams.set("symbol", args.asset);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(args.limit));
    if (args.endTime) url.searchParams.set("endTime", String(args.endTime.getTime()));

    const response = await fetch(url);
    if (response.status === 418 || response.status === 429) {
      throw new ExchangeRateLimitError(`Binance rate limited: ${response.status}`);
    }
    if (response.status === 400) {
      const body = await response.text();
      if (body.includes("Invalid symbol")) throw new AssetNotFoundError(args.asset);
      throw new Error(`Binance 400: ${body}`);
    }
    if (!response.ok) {
      throw new Error(`Binance ${response.status}: ${await response.text()}`);
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
      const url = `${this.config.baseUrl ?? "https://api.binance.com"}/api/v3/exchangeInfo`;
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
