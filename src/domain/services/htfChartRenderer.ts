import type { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
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
 * - Renders with all enabled indicators (using the same registry as the primary chart)
 */
export async function renderHtfChart(deps: {
  chartRenderer: ChartRenderer;
  indicatorCalculator: IndicatorCalculator;
  indicatorRegistry?: IndicatorRegistry;
  artifactStore: ArtifactStore;
  fetcher: MarketDataFetcher;
  asset: string;
}): Promise<string> {
  const dailies = await deps.fetcher.fetchOHLCV({
    asset: deps.asset,
    timeframe: "1d",
    limit: 200, // EMA200 warm-up window
  });

  const slice = dailies.slice(-60); // last ~2 months for the LLM
  const tempUri = `file:///tmp/temp-htf-${crypto.randomUUID()}.png`;

  let series: Record<string, import("@adapters/indicators/plugins/base/types").IndicatorSeriesContribution> = {};
  let enabledIds: readonly string[] = [];

  if (deps.indicatorRegistry && dailies.length >= 60) {
    // Use all registered plugins with default params for HTF chart
    const plugins = deps.indicatorRegistry.resolveActive({});
    if (plugins.length > 0) {
      const paramsByPlugin: Record<string, Record<string, unknown>> = {};
      for (const p of plugins) {
        paramsByPlugin[p.id] = (p.defaultParams as Record<string, unknown>) ?? {};
      }
      series = await deps.indicatorCalculator.computeSeries(slice, plugins, paramsByPlugin);
      enabledIds = plugins.map((p) => p.id);
    }
  }

  const result = await deps.chartRenderer.render({
    candles: slice,
    series,
    enabledIndicatorIds: enabledIds,
    width: 1280,
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
