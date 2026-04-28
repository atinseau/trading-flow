import type { PriceFeed, PriceTick } from "@domain/ports/PriceFeed";

export class YahooPollingPriceFeed implements PriceFeed {
  readonly source = "yahoo_polling";

  constructor(private opts: { pollIntervalMs?: number; userAgent?: string } = {}) {}

  async *subscribe(args: { watchId: string; assets: string[] }): AsyncIterable<PriceTick> {
    const intervalMs = this.opts.pollIntervalMs ?? 60_000;
    const ua = this.opts.userAgent ?? "trading-flow/1.0";

    while (true) {
      try {
        const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
        url.searchParams.set("symbols", args.assets.join(","));
        const response = await fetch(url, { headers: { "User-Agent": ua } });
        if (response.ok) {
          const data = (await response.json()) as {
            quoteResponse?: {
              result?: { symbol: string; regularMarketPrice: number; regularMarketTime: number }[];
            };
          };
          for (const q of data.quoteResponse?.result ?? []) {
            yield {
              asset: q.symbol,
              price: q.regularMarketPrice,
              timestamp: new Date(q.regularMarketTime * 1000),
            };
          }
        }
      } catch {
        /* swallow, retry next tick */
      }
      await Bun.sleep(intervalMs);
    }
  }
}
