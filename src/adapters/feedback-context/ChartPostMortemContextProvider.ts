import type { ArtifactStore } from "@domain/ports/ArtifactStore";
import type { ChartRenderer } from "@domain/ports/ChartRenderer";
import type {
  FeedbackContextChunk,
  FeedbackContextProvider,
  FeedbackContextScope,
} from "@domain/ports/FeedbackContextProvider";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";

const POST_CLOSE_MARGIN_MS = 4 * 60 * 60 * 1000;
const CHART_WIDTH = 1280;
const CHART_HEIGHT = 720;

export class ChartPostMortemContextProvider implements FeedbackContextProvider {
  readonly id = "chart-post-mortem";
  constructor(
    private readonly deps: {
      chartRenderer: ChartRenderer;
      marketDataFetcher: MarketDataFetcher;
      artifactStore: ArtifactStore;
    },
  ) {}

  isApplicable(_scope: FeedbackContextScope): boolean {
    return true;
  }

  async gather(scope: FeedbackContextScope): Promise<FeedbackContextChunk[]> {
    const candles = await this.deps.marketDataFetcher.fetchRange({
      asset: scope.asset,
      timeframe: scope.timeframe,
      from: scope.setupCreatedAt,
      to: new Date(scope.setupClosedAt.getTime() + POST_CLOSE_MARGIN_MS),
    });
    // Markers (CONFIRMED / close reason) are not yet supported by the
    // ChartRenderer port — the chart still has value without them. When
    // the renderer gains marker support, the call site below should be
    // updated to pass them.
    const tempUri = `file:///tmp/feedback-chart-${scope.setupId}-${crypto.randomUUID()}.png`;
    const result = await this.deps.chartRenderer.render({
      candles,
      series: {}, // TODO(Task 30): pass computed indicator series for post-mortem
      enabledIndicatorIds: [], // TODO(Task 30): resolve from watch config
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      outputUri: tempUri,
    });
    const stored = await this.deps.artifactStore.put({
      kind: "chart_image",
      content: result.content,
      mimeType: result.mimeType,
    });
    return [
      {
        providerId: this.id,
        title: "Chart post-mortem (full setup window)",
        content: { kind: "image", artifactUri: stored.uri, mimeType: result.mimeType },
      },
    ];
  }
}
