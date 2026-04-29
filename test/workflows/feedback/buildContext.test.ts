import { describe, expect, test } from "bun:test";
import type { FeedbackContextScope } from "@domain/ports/FeedbackContextProvider";
import { buildFeedbackContext } from "@workflows/feedback/buildContext";
import { FakeFeedbackContextProvider } from "../../fakes/FakeFeedbackContextProvider";

const scope: FeedbackContextScope = {
  setupId: "00000000-0000-0000-0000-000000000001",
  watchId: "btc-1h",
  asset: "BTCUSDT",
  timeframe: "1h",
  closeOutcome: { reason: "sl_hit_direct", everConfirmed: true },
  setupCreatedAt: new Date(),
  setupClosedAt: new Date(),
  confirmedAt: new Date(),
};

describe("buildFeedbackContext", () => {
  test("preserves provider order in output", async () => {
    const p1 = new FakeFeedbackContextProvider("a", [
      { providerId: "a", title: "A", content: { kind: "markdown", value: "alpha" } },
    ]);
    const p2 = new FakeFeedbackContextProvider("b", [
      { providerId: "b", title: "B", content: { kind: "markdown", value: "beta" } },
    ]);
    const out = await buildFeedbackContext(scope, [p1, p2]);
    expect(out.map((c) => c.providerId)).toEqual(["a", "b"]);
  });

  test("skips non-applicable providers", async () => {
    const p1 = new FakeFeedbackContextProvider(
      "a",
      [{ providerId: "a", title: "A", content: { kind: "markdown", value: "alpha" } }],
      false,
    );
    const p2 = new FakeFeedbackContextProvider("b", [
      { providerId: "b", title: "B", content: { kind: "markdown", value: "beta" } },
    ]);
    const out = await buildFeedbackContext(scope, [p1, p2]);
    expect(out.map((c) => c.providerId)).toEqual(["b"]);
  });

  test("flattens multiple chunks per provider", async () => {
    const p = new FakeFeedbackContextProvider("multi", [
      { providerId: "multi", title: "First", content: { kind: "markdown", value: "1" } },
      { providerId: "multi", title: "Second", content: { kind: "markdown", value: "2" } },
    ]);
    const out = await buildFeedbackContext(scope, [p]);
    expect(out).toHaveLength(2);
  });
});
