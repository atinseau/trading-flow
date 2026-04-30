import { AssetNotFoundError, ExchangeRateLimitError } from "@domain/errors";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Candle } from "@domain/schemas/Candle";
import { CandleSchema } from "@domain/schemas/Candle";
import { getLogger } from "@observability/logger";
import { z } from "zod";

const log = getLogger({ component: "yahoo-finance-fetcher" });

const YAHOO_BASE_URL = "https://query1.finance.yahoo.com";
const YAHOO_USER_AGENT = "trading-flow/1.0";

const TIMEFRAME_MAP: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "60m",
  "2h": "60m",
  "4h": "60m",
  "1d": "1d",
  "1w": "1wk",
};
const RANGE_BY_TIMEFRAME: Record<string, string> = {
  "1m": "1d",
  "5m": "5d",
  "15m": "5d",
  "30m": "5d",
  "1h": "60d",
  "2h": "60d",
  "4h": "60d",
  "1d": "5y",
  "1w": "10y",
};

const ChartResponseSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          timestamp: z.array(z.number()),
          indicators: z.object({
            quote: z.array(
              z.object({
                open: z.array(z.number().nullable()),
                high: z.array(z.number().nullable()),
                low: z.array(z.number().nullable()),
                close: z.array(z.number().nullable()),
                volume: z.array(z.number().nullable()),
              }),
            ),
          }),
        }),
      )
      .nullable(),
    error: z.unknown().nullable(),
  }),
});

export class YahooFinanceFetcher implements MarketDataFetcher {
  readonly source = "yahoo";

  async fetchOHLCV(args: {
    asset: string;
    timeframe: string;
    limit: number;
    endTime?: Date;
  }): Promise<Candle[]> {
    const interval = TIMEFRAME_MAP[args.timeframe];
    if (!interval) throw new Error(`Timeframe non supporté: ${args.timeframe}`);
    const range = RANGE_BY_TIMEFRAME[args.timeframe];

    const url = new URL(`${YAHOO_BASE_URL}/v8/finance/chart/${encodeURIComponent(args.asset)}`);
    url.searchParams.set("interval", interval);
    if (range) url.searchParams.set("range", range);

    const response = await fetch(url, {
      headers: { "User-Agent": YAHOO_USER_AGENT },
    });
    if (response.status === 429) {
      log.warn({ asset: args.asset, status: 429 }, "yahoo rate limited");
      throw new ExchangeRateLimitError("yahoo 429");
    }
    if (response.status === 404) {
      log.error({ asset: args.asset }, "yahoo asset not found");
      throw new AssetNotFoundError(args.asset);
    }
    if (!response.ok) {
      const body = await response.text();
      log.error({ asset: args.asset, status: response.status }, "yahoo fetch failed");
      throw new Error(`Yahoo ${response.status}: ${body}`);
    }

    const data = ChartResponseSchema.parse(await response.json());
    const result = data.chart.result?.[0];
    if (!result) throw new AssetNotFoundError(args.asset);

    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    if (!q) throw new AssetNotFoundError(args.asset);
    const candles: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open[i];
      const h = q.high[i];
      const l = q.low[i];
      const c = q.close[i];
      const v = q.volume[i];
      const t = ts[i];
      if (o == null || h == null || l == null || c == null || v == null || t == null) continue;
      candles.push(
        CandleSchema.parse({
          timestamp: new Date(t * 1000),
          open: o,
          high: h,
          low: l,
          close: c,
          volume: v,
        }),
      );
    }
    return candles.slice(-args.limit);
  }

  async fetchRange(args: {
    asset: string;
    timeframe: string;
    from: Date;
    to: Date;
  }): Promise<Candle[]> {
    // Yahoo's chart API uses range presets, not arbitrary time windows. We
    // fetch the natural range for the timeframe, then filter client-side.
    // Limit is set very high so the slice doesn't truncate before filtering.
    const all = await this.fetchOHLCV({
      asset: args.asset,
      timeframe: args.timeframe,
      limit: 10_000,
    });
    // Observability: if the requested window starts before Yahoo's earliest
    // returned candle, the range preset capped data and the result is
    // silently truncated at the head. Log a warning so callers (e.g. the
    // post-mortem chart) can spot incomplete windows in production.
    const earliest = all[0];
    if (earliest) {
      if (args.from.getTime() < earliest.timestamp.getTime()) {
        log.warn(
          {
            asset: args.asset,
            timeframe: args.timeframe,
            from: args.from.toISOString(),
            earliest: earliest.timestamp.toISOString(),
          },
          "yahoo fetchRange: requested window starts before earliest available data (range preset cap)",
        );
      }
    }
    return all.filter(
      (c) =>
        c.timestamp.getTime() >= args.from.getTime() && c.timestamp.getTime() <= args.to.getTime(),
    );
  }

  async isAssetSupported(asset: string): Promise<boolean> {
    try {
      await this.fetchOHLCV({ asset, timeframe: "1d", limit: 1 });
      return true;
    } catch {
      return false;
    }
  }
}
