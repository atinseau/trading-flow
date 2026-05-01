import type { IndicatorScalars } from "@domain/schemas/Indicators";

export type TickSnapshot = {
  id: string;
  watchId: string;
  tickAt: Date;
  asset: string;
  timeframe: string;
  ohlcvUri: string;
  chartUri: string;
  indicators: IndicatorScalars;
  /** Last candle close at snapshot time. Source of truth for "live price"
      in HTF/regime computation. Null for legacy rows. */
  lastClose: number | null;
  preFilterPass: boolean;
};
