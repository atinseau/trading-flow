import {
  encodeCallbackData,
  formatLessonProposalMessage,
  parseCallbackData,
} from "@adapters/notify/lessonProposalFormat";
import { describe, expect, test } from "bun:test";

describe("callback_data encoding", () => {
  test("round-trips for approve", () => {
    const lessonId = "11111111-1111-1111-1111-111111111111";
    const enc = encodeCallbackData({ action: "approve", lessonId });
    expect(enc.length).toBeLessThanOrEqual(64);
    expect(parseCallbackData(enc)).toEqual({ action: "approve", lessonId });
  });
  test("round-trips for reject", () => {
    const lessonId = "11111111-1111-1111-1111-111111111111";
    const enc = encodeCallbackData({ action: "reject", lessonId });
    expect(parseCallbackData(enc)).toEqual({ action: "reject", lessonId });
  });
  test("rejects malformed input", () => {
    expect(parseCallbackData("malformed")).toBeNull();
    expect(parseCallbackData("v2|a|some")).toBeNull();
  });
});

describe("formatLessonProposalMessage", () => {
  test("CREATE renders core fields", () => {
    const msg = formatLessonProposalMessage({
      kind: "CREATE",
      watchId: "btc-1h",
      category: "reviewing",
      title: "RSI vs price divergence in late trend",
      body: "When RSI fails to confirm new price extremes within three candles of a structural pivot, weight continuation lower.",
      rationale: "Observed price-vs-RSI divergence over six ticks",
      triggerSetupId: "11111111-1111-1111-1111-111111111111",
      triggerCloseReason: "sl_hit_after_tp1",
    });
    expect(msg).toContain("New lesson proposed");
    expect(msg).toContain("btc-1h");
    expect(msg).toContain("RSI vs price divergence");
  });

  test("REFINE includes Before/After diff", () => {
    const msg = formatLessonProposalMessage({
      kind: "REFINE",
      watchId: "btc-1h",
      category: "reviewing",
      title: "Refined title",
      body: "Refined body",
      rationale: "z".repeat(20),
      triggerSetupId: "11111111-1111-1111-1111-111111111111",
      triggerCloseReason: "sl_hit_direct",
      before: { title: "Old title", body: "Old body" },
    });
    expect(msg).toContain("Before");
    expect(msg).toContain("Old title");
    expect(msg).toContain("Refined title");
  });
});
