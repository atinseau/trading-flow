import type { ArtifactStore } from "@domain/ports/ArtifactStore";
import type { ChartRenderer } from "@domain/ports/ChartRenderer";
import type { IndicatorCalculator } from "@domain/ports/IndicatorCalculator";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";

/**
 * Render the daily-timeframe chart for an asset on demand. Used by the
 * reviewer when it explicitly requests HTF context (tool-call pattern) and
 * by the finalizer (always). Returns the persisted artifact URI.
 *
 * Light vs the main chart:
 * - 60 daily candles = ~2 months of context
 * - Same multi-pane template (we get EMAs/BB/MACD on daily for free) — the
 *   LLM benefits from seeing the same indicator vocabulary applied to a
 *   different timeframe.
 */
export async function renderHtfChart(deps: {
  chartRenderer: ChartRenderer;
  indicatorCalculator: IndicatorCalculator;
  artifactStore: ArtifactStore;
  fetcher: MarketDataFetcher;
  asset: string;
}): Promise<string> {
  const dailies = await deps.fetcher.fetchOHLCV({
    asset: deps.asset,
    timeframe: "1d",
    limit: 200, // EMA200 warm-up window
  });
  if (dailies.length < 200) {
    // Not enough HTF data — render with whatever we have, no indicators.
    const tempUri = `file:///tmp/temp-htf-${crypto.randomUUID()}.png`;
    const result = await deps.chartRenderer.render({
      candles: dailies,
      width: 1600,
      height: 900,
      outputUri: tempUri,
    });
    const stored = await deps.artifactStore.put({
      kind: "chart_image",
      content: result.content,
      mimeType: result.mimeType,
    });
    return stored.uri;
  }

  const fullSeries = await deps.indicatorCalculator.computeSeries(dailies);
  const visibleWindow = 60; // last ~2 months for the LLM, on a 200-candle compute base
  const slice = dailies.slice(-visibleWindow);
  const offset = dailies.length - slice.length;
  const sliceLine = (arr: (number | null)[]) => arr.slice(-visibleWindow);
  const sliceMarkers = <T extends { index: number }>(arr: T[]) =>
    arr.filter((m) => m.index >= offset).map((m) => ({ ...m, index: m.index - offset }));

  const indicators = {
    ema20: sliceLine(fullSeries.ema20),
    ema50: sliceLine(fullSeries.ema50),
    ema200: sliceLine(fullSeries.ema200),
    vwap: sliceLine(fullSeries.vwap),
    bbUpper: sliceLine(fullSeries.bbUpper),
    bbMiddle: sliceLine(fullSeries.bbMiddle),
    bbLower: sliceLine(fullSeries.bbLower),
    rsi: sliceLine(fullSeries.rsi),
    atr: sliceLine(fullSeries.atr),
    atrMa20: sliceLine(fullSeries.atrMa20),
    volumeMa20: sliceLine(fullSeries.volumeMa20),
    macd: sliceLine(fullSeries.macd),
    macdSignal: sliceLine(fullSeries.macdSignal),
    macdHist: sliceLine(fullSeries.macdHist),
    swingHighs: sliceMarkers(fullSeries.swingHighs),
    swingLows: sliceMarkers(fullSeries.swingLows),
    fvgs: sliceMarkers(fullSeries.fvgs),
    equalHighs: fullSeries.equalHighs
      .map((g) => ({
        price: g.price,
        indices: g.indices.filter((i) => i >= offset).map((i) => i - offset),
      }))
      .filter((g) => g.indices.length >= 2),
    equalLows: fullSeries.equalLows
      .map((g) => ({
        price: g.price,
        indices: g.indices.filter((i) => i >= offset).map((i) => i - offset),
      }))
      .filter((g) => g.indices.length >= 2),
  };

  const tempUri = `file:///tmp/temp-htf-${crypto.randomUUID()}.png`;
  const result = await deps.chartRenderer.render({
    candles: slice,
    indicators,
    width: 1600,
    height: 900,
    outputUri: tempUri,
  });
  const stored = await deps.artifactStore.put({
    kind: "chart_image",
    content: result.content,
    mimeType: result.mimeType,
  });
  return stored.uri;
}
