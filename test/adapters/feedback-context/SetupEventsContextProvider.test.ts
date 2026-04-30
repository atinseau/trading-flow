import { describe, expect, test } from "bun:test";
import { SetupEventsContextProvider } from "@adapters/feedback-context/SetupEventsContextProvider";
import type { FeedbackContextScope } from "@domain/ports/FeedbackContextProvider";
import { InMemoryEventStore } from "../../fakes/InMemoryEventStore";

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

describe("SetupEventsContextProvider", () => {
  test("returns markdown timeline of all events for the setup", async () => {
    const eventStore = new InMemoryEventStore();
    await eventStore.append(
      {
        setupId: scope.setupId,
        stage: "detector",
        actor: "detector_v4",
        type: "SetupCreated",
        scoreDelta: 0,
        scoreAfter: 25,
        statusBefore: "CANDIDATE",
        statusAfter: "REVIEWING",
        payload: {
          type: "SetupCreated",
          data: {
            pattern: "double_bottom",
            direction: "LONG",
            keyLevels: { invalidation: 41700 },
            initialScore: 25,
            rawObservation: "Initial detection",
          },
        },
      },
      { score: 25, status: "REVIEWING", invalidationLevel: 41700 },
    );
    const provider = new SetupEventsContextProvider({ eventStore });
    expect(provider.id).toBe("setup-events");
    expect(provider.isApplicable(scope)).toBe(true);
    const chunks = await provider.gather(scope);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content.kind).toBe("markdown");
    if (chunks[0]?.content.kind === "markdown") {
      expect(chunks[0].content.value).toContain("SetupCreated");
      expect(chunks[0].content.value).toContain("double_bottom");
    }
  });
});
