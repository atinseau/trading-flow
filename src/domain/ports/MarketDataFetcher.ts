import type { Candle } from "@domain/schemas/Candle";

export interface MarketDataFetcher {
  readonly source: string;
  fetchOHLCV(args: {
    asset: string;
    timeframe: string;
    limit: number;
    endTime?: Date;
  }): Promise<Candle[]>;
  isAssetSupported(asset: string): Promise<boolean>;
}
