import type { Candle } from "@domain/schemas/Candle";

export type ChartRenderResult = {
  uri: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  content: Buffer;
};

export interface ChartRenderer {
  render(args: {
    candles: Candle[];
    width: number;
    height: number;
    outputUri: string;
  }): Promise<ChartRenderResult>;
}
