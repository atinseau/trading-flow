import type { Candle } from "@domain/schemas/Candle";

export interface MarketDataFetcher {
  readonly source: string;
  fetchOHLCV(args: {
    asset: string;
    timeframe: string;
    limit: number;
    endTime?: Date;
  }): Promise<Candle[]>;
  /**
   * Fetch all candles whose timestamp falls inside [from, to] (inclusive).
   * Adapters that have a native range API should use it; otherwise they
   * may emulate via fetchOHLCV + client-side filtering.
   */
  fetchRange(args: { asset: string; timeframe: string; from: Date; to: Date }): Promise<Candle[]>;
  isAssetSupported(asset: string): Promise<boolean>;
}
