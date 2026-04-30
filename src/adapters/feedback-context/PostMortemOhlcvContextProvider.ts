import type {
  FeedbackContextChunk,
  FeedbackContextProvider,
  FeedbackContextScope,
} from "@domain/ports/FeedbackContextProvider";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";

const POST_CLOSE_MARGIN_MS = 4 * 60 * 60 * 1000; // 4h margin after close

export class PostMortemOhlcvContextProvider implements FeedbackContextProvider {
  readonly id = "post-mortem-ohlcv";
  constructor(private readonly deps: { marketDataFetcher: MarketDataFetcher }) {}

  isApplicable(scope: FeedbackContextScope): boolean {
    return scope.confirmedAt !== null;
  }

  async gather(scope: FeedbackContextScope): Promise<FeedbackContextChunk[]> {
    if (!scope.confirmedAt) return [];
    const candles = await this.deps.marketDataFetcher.fetchRange({
      asset: scope.asset,
      timeframe: scope.timeframe,
      from: scope.confirmedAt,
      to: new Date(scope.setupClosedAt.getTime() + POST_CLOSE_MARGIN_MS),
    });
    const lines: string[] = [];
    lines.push(`### Post-confirmation OHLCV (${candles.length} candles)\n`);
    lines.push("| time | open | high | low | close | volume |");
    lines.push("|---|---|---|---|---|---|");
    for (const c of candles) {
      lines.push(
        `| ${c.timestamp.toISOString()} | ${c.open} | ${c.high} | ${c.low} | ${c.close} | ${c.volume} |`,
      );
    }
    return [
      {
        providerId: this.id,
        title: "Post-mortem OHLCV",
        content: { kind: "markdown", value: lines.join("\n") },
      },
    ];
  }
}
