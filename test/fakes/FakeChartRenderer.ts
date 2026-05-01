import { createHash } from "node:crypto";
import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";
import type { ChartRenderer, ChartRenderResult } from "@domain/ports/ChartRenderer";
import type { Candle } from "@domain/schemas/Candle";

export class FakeChartRenderer implements ChartRenderer {
  callCount = 0;

  async warmUp(): Promise<void> {}

  async dispose(): Promise<void> {}

  async render(args: {
    candles: Candle[];
    series: Record<string, IndicatorSeriesContribution>;
    enabledIndicatorIds: ReadonlyArray<string>;
    outputUri: string;
    width: number;
    height: number;
  }): Promise<ChartRenderResult> {
    this.callCount++;
    const fakePng = Buffer.from(`fake-png-${args.candles.length}-${args.width}x${args.height}`);
    return {
      uri: args.outputUri,
      sha256: createHash("sha256").update(fakePng).digest("hex"),
      bytes: fakePng.length,
      mimeType: "image/png",
      content: fakePng,
    };
  }
}
