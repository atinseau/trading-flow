import { describe, expect, test } from "bun:test";
import { ChartPostMortemContextProvider } from "@adapters/feedback-context/ChartPostMortemContextProvider";
import type { FeedbackContextScope } from "@domain/ports/FeedbackContextProvider";
import { FakeChartRenderer } from "../../fakes/FakeChartRenderer";
import { FakeMarketDataFetcher } from "../../fakes/FakeMarketDataFetcher";
import { InMemoryArtifactStore } from "../../fakes/InMemoryArtifactStore";

const scope: FeedbackContextScope = {
  setupId: "11111111-1111-1111-1111-111111111111",
  watchId: "btc-1h",
  asset: "BTCUSDT",
  timeframe: "1h",
  closeOutcome: { reason: "sl_hit_direct", everConfirmed: true },
  setupCreatedAt: new Date("2026-04-29T10:00:00Z"),
  setupClosedAt: new Date("2026-04-29T14:00:00Z"),
  confirmedAt: new Date("2026-04-29T12:00:00Z"),
};

describe("ChartPostMortemContextProvider", () => {
  test("renders a chart and persists it to ArtifactStore (returns durable URI)", async () => {
    const renderer = new FakeChartRenderer();
    const fetcher = new FakeMarketDataFetcher();
    const artifactStore = new InMemoryArtifactStore();
    fetcher.seed("BTCUSDT", "1h", [
      {
        open: 42100,
        high: 42200,
        low: 41900,
        close: 41950,
        volume: 1234,
        timestamp: new Date("2026-04-29T10:00:00Z"),
      },
      {
        open: 41950,
        high: 42000,
        low: 41700,
        close: 41720,
        volume: 1500,
        timestamp: new Date("2026-04-29T13:00:00Z"),
      },
    ]);
    const provider = new ChartPostMortemContextProvider({
      chartRenderer: renderer,
      marketDataFetcher: fetcher,
      artifactStore,
    });
    expect(provider.id).toBe("chart-post-mortem");
    expect(provider.isApplicable(scope)).toBe(true);
    const chunks = await provider.gather(scope);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content.kind).toBe("image");
    if (chunks[0]?.content.kind === "image") {
      expect(chunks[0].content.mimeType).toBe("image/png");
      // The URI must be the durable artifact-store URI (e.g. "mem://..."),
      // not the ephemeral /tmp file path.
      expect(chunks[0].content.artifactUri).toMatch(/^mem:\/\//);
      expect(chunks[0].content.artifactUri).not.toMatch(/\/tmp\//);
      // Artifact must actually be persisted in the store.
      const stored = await artifactStore.get(chunks[0].content.artifactUri);
      expect(stored.length).toBeGreaterThan(0);
    }
    expect(renderer.callCount).toBe(1);
    expect(artifactStore.blobs.size).toBe(1);
  });

  test("queries the full setup window with margin (createdAt..closedAt+4h)", async () => {
    const renderer = new FakeChartRenderer();
    const fetcher = new FakeMarketDataFetcher();
    const artifactStore = new InMemoryArtifactStore();
    fetcher.seed("BTCUSDT", "1h", []);
    const provider = new ChartPostMortemContextProvider({
      chartRenderer: renderer,
      marketDataFetcher: fetcher,
      artifactStore,
    });
    await provider.gather(scope);
    expect(fetcher.rangeCallsLog).toHaveLength(1);
    const call = fetcher.rangeCallsLog[0]!;
    expect(call.from.toISOString()).toBe("2026-04-29T10:00:00.000Z");
    expect(call.to.toISOString()).toBe("2026-04-29T18:00:00.000Z");
  });

  test("persists chart bytes with kind 'chart_image' and mimeType 'image/png'", async () => {
    const renderer = new FakeChartRenderer();
    const fetcher = new FakeMarketDataFetcher();
    const artifactStore = new InMemoryArtifactStore();
    // Spy on artifactStore.put
    const putCalls: { kind: string; mimeType: string; bytes: number }[] = [];
    const originalPut = artifactStore.put.bind(artifactStore);
    artifactStore.put = async (args) => {
      putCalls.push({
        kind: args.kind,
        mimeType: args.mimeType,
        bytes: args.content.length,
      });
      return originalPut(args);
    };
    fetcher.seed("BTCUSDT", "1h", []);
    const provider = new ChartPostMortemContextProvider({
      chartRenderer: renderer,
      marketDataFetcher: fetcher,
      artifactStore,
    });
    await provider.gather(scope);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.kind).toBe("chart_image");
    expect(putCalls[0]!.mimeType).toBe("image/png");
    expect(putCalls[0]!.bytes).toBeGreaterThan(0);
  });
});
