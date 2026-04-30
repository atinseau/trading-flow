import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";
import type { Candle } from "@domain/schemas/Candle";

export type ChartRenderResult = {
  uri: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  content: Buffer;
};

export interface ChartRenderer {
  warmUp(): Promise<void>;
  dispose(): Promise<void>;
  render(args: {
    candles: Candle[];
    series: Record<string, IndicatorSeriesContribution>;
    enabledIndicatorIds: ReadonlyArray<string>;
    width: number;
    height: number;
    outputUri: string;
  }): Promise<ChartRenderResult>;
}
