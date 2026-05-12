import type { ArtifactStore } from "@domain/ports/ArtifactStore";
import type { ChartRenderer } from "@domain/ports/ChartRenderer";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { StoredReplayEvent } from "@domain/ports/ReplayEventStore";
import type { Candle } from "@domain/schemas/Candle";

/**
 * Replay-scoped feedback context assembly. Mirrors the live
 * `buildFeedbackContext` + provider chain but pulls events from
 * `replay_events` instead of `events`, and treats the timestamps as
 * simulated rather than wall-clock.
 *
 * Three context chunks (matching live, minus TickSnapshotsContextProvider
 * which has no analogue in replay — we don't persist tick snapshots) :
 *  - `setup-events` : timeline of the setup's events as markdown.
 *  - `post-mortem-ohlcv` : candles from confirmation → 4h after close
 *    as a markdown table (skipped if the setup never confirmed).
 *  - `chart-post-mortem` : rendered chart of the same window as an
 *    image artifact.
 *
 * Pure orchestration : the function takes adapters at the boundary,
 * does no IO of its own beyond what the adapters do.
 */
export type ReplayFeedbackChunk = {
  providerId: string;
  title: string;
  content:
    | { kind: "markdown"; value: string }
    | { kind: "image"; artifactUri: string; mimeType: string };
};

const POST_CLOSE_MARGIN_MS = 4 * 60 * 60 * 1000;

/**
 * Extracts the timeline timestamps from a setup's replay events. Returns
 * `null` for fields that can't be derived (e.g. no `Confirmed` event
 * means the setup never confirmed, so the post-mortem OHLCV chunk
 * doesn't apply).
 */
export function deriveSetupTimeline(events: StoredReplayEvent[]): {
  setupCreatedAt: Date | null;
  setupClosedAt: Date | null;
  confirmedAt: Date | null;
} {
  let setupCreatedAt: Date | null = null;
  let confirmedAt: Date | null = null;
  let setupClosedAt: Date | null = null;
  for (const e of events) {
    if (e.type === "SetupCreated" && setupCreatedAt === null) {
      setupCreatedAt = e.occurredAt;
    }
    if (e.type === "Confirmed" && confirmedAt === null) {
      confirmedAt = e.occurredAt;
    }
    // The last "terminal" event marks the close. Cover all terminal types.
    if (
      e.type === "SLHit" ||
      e.type === "TPHit" ||
      e.type === "Invalidated" ||
      e.type === "Rejected" ||
      e.type === "Expired" ||
      e.type === "Killed"
    ) {
      setupClosedAt = e.occurredAt;
    }
  }
  return { setupCreatedAt, setupClosedAt, confirmedAt };
}

/**
 * Markdown timeline of a setup's events. Mirrors the layout used by the
 * live `SetupEventsContextProvider` so the feedback prompt sees a
 * consistent shape across live and replay.
 */
export function formatSetupEventsMarkdown(events: StoredReplayEvent[]): string {
  const lines: string[] = [];
  lines.push(`### Setup timeline (${events.length} events)\n`);
  for (const e of events) {
    const scoreAfter = e.scoreAfter ?? 0;
    const scoreBefore = scoreAfter - e.scoreDelta;
    lines.push(`#### Tick ${e.sequence} — ${e.type} (${e.occurredAt.toISOString()})`);
    lines.push(`- score: ${scoreBefore} → ${scoreAfter}`);
    lines.push(`- status: ${e.statusBefore ?? "—"} → ${e.statusAfter ?? "—"}`);
    const payload = e.payload as { data?: Record<string, unknown> };
    const data = (payload.data ?? {}) as Record<string, unknown>;
    if (typeof data.pattern === "string") {
      lines.push(`- pattern: ${data.pattern}`);
    }
    if (typeof data.reasoning === "string") {
      lines.push(`- reasoning: ${data.reasoning}`);
    }
    if (Array.isArray(data.observations)) {
      const obs = data.observations as { kind?: string; text?: string }[];
      for (const o of obs) {
        lines.push(`  - **${o.kind ?? "obs"}**: ${o.text ?? ""}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Markdown OHLCV table from `confirmedAt` to `closedAt + 4h`. Mirrors
 * the live `PostMortemOhlcvContextProvider`. Returns null when the setup
 * never confirmed (no useful window).
 */
export function formatPostMortemOhlcvMarkdown(candles: Candle[]): string {
  const lines: string[] = [];
  lines.push(`### Post-confirmation OHLCV (${candles.length} candles)\n`);
  lines.push("| time | open | high | low | close | volume |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of candles) {
    lines.push(
      `| ${c.timestamp.toISOString()} | ${c.open} | ${c.high} | ${c.low} | ${c.close} | ${c.volume} |`,
    );
  }
  return lines.join("\n");
}

export type BuildReplayFeedbackContextDeps = {
  marketDataFetcher: MarketDataFetcher;
  chartRenderer: ChartRenderer;
  artifactStore: ArtifactStore;
};

export type BuildReplayFeedbackContextArgs = {
  asset: string;
  timeframe: string;
  setupEvents: StoredReplayEvent[];
};

/**
 * Builds the full chunk list a replay feedback analysis should see.
 * Returns an empty array if the setup never confirmed (the LLM in that
 * case has only the bare close outcome + score + existing-lessons pool,
 * which is enough — there's no trade to analyze).
 */
export async function buildReplayFeedbackContext(
  deps: BuildReplayFeedbackContextDeps,
  args: BuildReplayFeedbackContextArgs,
): Promise<ReplayFeedbackChunk[]> {
  const chunks: ReplayFeedbackChunk[] = [];
  const { setupCreatedAt, setupClosedAt, confirmedAt } = deriveSetupTimeline(args.setupEvents);

  // 1. Setup timeline (always applicable).
  chunks.push({
    providerId: "setup-events",
    title: "Setup timeline (events)",
    content: { kind: "markdown", value: formatSetupEventsMarkdown(args.setupEvents) },
  });

  // 2. Post-mortem OHLCV + chart only apply if the setup confirmed
  //    (otherwise there's no "trade window" to analyze).
  if (confirmedAt !== null && setupClosedAt !== null && setupCreatedAt !== null) {
    const ohlcvCandles = await deps.marketDataFetcher.fetchRange({
      asset: args.asset,
      timeframe: args.timeframe,
      from: confirmedAt,
      to: new Date(setupClosedAt.getTime() + POST_CLOSE_MARGIN_MS),
    });
    chunks.push({
      providerId: "post-mortem-ohlcv",
      title: "Post-mortem OHLCV",
      content: { kind: "markdown", value: formatPostMortemOhlcvMarkdown(ohlcvCandles) },
    });

    // Chart spans the full setup window (creation → close + 4h margin).
    const chartCandles = await deps.marketDataFetcher.fetchRange({
      asset: args.asset,
      timeframe: args.timeframe,
      from: setupCreatedAt,
      to: new Date(setupClosedAt.getTime() + POST_CLOSE_MARGIN_MS),
    });
    if (chartCandles.length > 0) {
      const tempUri = `file:///tmp/replay-feedback-chart-${crypto.randomUUID()}.png`;
      const rendered = await deps.chartRenderer.render({
        candles: chartCandles,
        series: {},
        enabledIndicatorIds: [],
        width: 1280,
        height: 720,
        outputUri: tempUri,
      });
      const stored = await deps.artifactStore.put({
        kind: "chart_image",
        content: rendered.content,
        mimeType: rendered.mimeType,
      });
      chunks.push({
        providerId: "chart-post-mortem",
        title: "Chart post-mortem (full setup window)",
        content: { kind: "image", artifactUri: stored.uri, mimeType: rendered.mimeType },
      });
    }
  }

  return chunks;
}
