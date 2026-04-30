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
  preFilterPass: boolean;
};
