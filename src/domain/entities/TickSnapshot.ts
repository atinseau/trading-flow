import type { Indicators } from "@domain/schemas/Indicators";

export type TickSnapshot = {
  id: string;
  watchId: string;
  tickAt: Date;
  asset: string;
  timeframe: string;
  ohlcvUri: string;
  chartUri: string;
  indicators: Indicators;
  preFilterPass: boolean;
};
