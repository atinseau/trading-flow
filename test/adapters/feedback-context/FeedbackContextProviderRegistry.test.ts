import { describe, expect, test } from "bun:test";
import { FeedbackContextProviderRegistry } from "@adapters/feedback-context/FeedbackContextProviderRegistry";
import { FakeFeedbackContextProvider } from "../../fakes/FakeFeedbackContextProvider";

const CANONICAL_ORDER = [
  "setup-events",
  "tick-snapshots",
  "post-mortem-ohlcv",
  "chart-post-mortem",
];

function makeProvider(id: string) {
  return new FakeFeedbackContextProvider(id, []);
}

describe("FeedbackContextProviderRegistry", () => {
  test("preserves canonical order regardless of insertion order", () => {
    // Insert providers in a deliberately scrambled order.
    const registry = new FeedbackContextProviderRegistry({
      "chart-post-mortem": makeProvider("chart-post-mortem"),
      "setup-events": makeProvider("setup-events"),
      "post-mortem-ohlcv": makeProvider("post-mortem-ohlcv"),
      "tick-snapshots": makeProvider("tick-snapshots"),
    });
    const resolved = registry.resolveForWatch([]);
    expect(resolved.map((p) => p.id)).toEqual(CANONICAL_ORDER);
  });

  test("filters disabled IDs from the resolved list", () => {
    const registry = new FeedbackContextProviderRegistry({
      "setup-events": makeProvider("setup-events"),
      "tick-snapshots": makeProvider("tick-snapshots"),
      "post-mortem-ohlcv": makeProvider("post-mortem-ohlcv"),
      "chart-post-mortem": makeProvider("chart-post-mortem"),
    });
    const resolved = registry.resolveForWatch(["chart-post-mortem"]);
    expect(resolved.map((p) => p.id)).toEqual([
      "setup-events",
      "tick-snapshots",
      "post-mortem-ohlcv",
    ]);
    expect(resolved.find((p) => p.id === "chart-post-mortem")).toBeUndefined();
  });

  test("unknown disabled IDs warn but do not throw; resolved list is full canonical", () => {
    const registry = new FeedbackContextProviderRegistry({
      "setup-events": makeProvider("setup-events"),
      "tick-snapshots": makeProvider("tick-snapshots"),
      "post-mortem-ohlcv": makeProvider("post-mortem-ohlcv"),
      "chart-post-mortem": makeProvider("chart-post-mortem"),
    });
    let resolved: ReturnType<typeof registry.resolveForWatch> = [];
    expect(() => {
      resolved = registry.resolveForWatch(["does-not-exist", "also-fake"]);
    }).not.toThrow();
    expect(resolved.map((p) => p.id)).toEqual(CANONICAL_ORDER);
  });
});
