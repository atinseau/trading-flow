import { describe, expect, test } from "bun:test";
import {
  formatConfirmedPreview,
  formatExpiredPreview,
  formatInvalidatedAfterConfirmedPreview,
  formatRejectedPreview,
  formatReviewerVerdictPreview,
  formatSetupCreatedPreview,
  formatSLHitPreview,
  formatTPHitPreview,
} from "@domain/notify/formatTelegramText";

/**
 * Direct unit tests for the 8 pure Telegram formatters. Each test
 * exercises one formatter, including its branches (includeReasoning
 * toggle, empty takeProfit, final vs intermediate TP, etc.) so a
 * future refactor can't silently break the live Telegram message
 * layout.
 */

describe("formatSetupCreatedPreview", () => {
  test("LONG setup with raw observation", () => {
    const out = formatSetupCreatedPreview({
      watchId: "btc-1h",
      asset: "BTCUSDT",
      timeframe: "1h",
      patternHint: "bullish_engulfing",
      direction: "LONG",
      initialScore: 75,
      invalidationLevel: 29_500,
      rawObservation: "Strong engulfing on volume.",
    });
    expect(out).toContain("🆕 New setup detected — btc-1h");
    expect(out).toContain("BTCUSDT 1h | 🟢 LONG | pattern=bullish_engulfing");
    expect(out).toContain("Score initial: 75/100");
    expect(out).toContain("Invalidation: 29500");
    expect(out).toContain("Strong engulfing on volume.");
  });

  test("SHORT setup", () => {
    const out = formatSetupCreatedPreview({
      watchId: "eth-1h",
      asset: "ETHUSDT",
      timeframe: "1h",
      patternHint: "double_top",
      direction: "SHORT",
      initialScore: 50,
      invalidationLevel: 3_100,
      rawObservation: "Lower high at resistance.",
    });
    expect(out).toContain("🔴 SHORT");
  });
});

describe("formatReviewerVerdictPreview", () => {
  test("STRENGTHEN with reasoning included", () => {
    const out = formatReviewerVerdictPreview({
      asset: "BTCUSDT",
      timeframe: "1h",
      verdict: "STRENGTHEN",
      scoreBefore: 60,
      scoreAfter: 70,
      reasoning: "Volume confirms breakout.",
      includeReasoning: true,
    });
    expect(out).toContain("💪 STRENGTHEN +10 — BTCUSDT 1h");
    expect(out).toContain("Score: 60→70");
    expect(out).toContain("Volume confirms breakout.");
  });

  test("WEAKEN with reasoning suppressed", () => {
    const out = formatReviewerVerdictPreview({
      asset: "ETHUSDT",
      timeframe: "15m",
      verdict: "WEAKEN",
      scoreBefore: 70,
      scoreAfter: 55,
      reasoning: "Volume dried up.",
      includeReasoning: false,
    });
    expect(out).toContain("💔 WEAKEN -15 — ETHUSDT 15m");
    expect(out).toContain("Score: 70→55");
    expect(out).not.toContain("Volume dried up.");
  });

  test("STRENGTHEN with empty reasoning : no trailing blank line", () => {
    const out = formatReviewerVerdictPreview({
      asset: "X",
      timeframe: "1h",
      verdict: "STRENGTHEN",
      scoreBefore: 60,
      scoreAfter: 65,
      reasoning: "",
      includeReasoning: true,
    });
    // Should be header + Score, no trailing blank line.
    expect(out.split("\n")).toHaveLength(2);
  });
});

describe("formatConfirmedPreview", () => {
  test("LONG with TPs + reasoning", () => {
    const out = formatConfirmedPreview({
      asset: "BTCUSDT",
      timeframe: "1h",
      direction: "LONG",
      entry: 30_000,
      stopLoss: 29_500,
      takeProfit: [30_500, 31_000],
      reasoning: "Triple confluence.",
      includeReasoning: true,
    });
    expect(out).toContain("🟢 LONG BTCUSDT 1h");
    expect(out).toContain("Entry: 30000");
    expect(out).toContain("SL: 29500");
    expect(out).toContain("TP: 30500 / 31000");
    expect(out).toContain("Triple confluence.");
  });

  test("SHORT without reasoning + empty TP list", () => {
    const out = formatConfirmedPreview({
      asset: "ETHUSDT",
      timeframe: "4h",
      direction: "SHORT",
      entry: 3_000,
      stopLoss: 3_100,
      takeProfit: [],
      reasoning: "...",
      includeReasoning: false,
    });
    expect(out).toContain("🔴 SHORT");
    expect(out).not.toContain("TP: ");
    expect(out).not.toContain("...");
  });
});

describe("formatRejectedPreview", () => {
  test("includes the rejection reasoning", () => {
    const out = formatRejectedPreview({
      asset: "BTCUSDT",
      timeframe: "1h",
      reasoning: "R:R below minimum.",
    });
    expect(out).toContain("❌ Setup BTCUSDT 1h rejected");
    expect(out).toContain("R:R below minimum.");
  });
});

describe("formatTPHitPreview", () => {
  test("intermediate TP1 (not final)", () => {
    const out = formatTPHitPreview({
      asset: "BTCUSDT",
      timeframe: "1h",
      level: 30_500,
      index: 0,
      isFinal: false,
    });
    expect(out).toBe("🎯 TP1 hit on BTCUSDT 1h @ 30500");
  });

  test("final TP marks the close", () => {
    const out = formatTPHitPreview({
      asset: "BTCUSDT",
      timeframe: "1h",
      level: 31_000,
      index: 1,
      isFinal: true,
    });
    expect(out).toBe("🎯 TP2 hit on BTCUSDT 1h @ 31000 (final, position closed)");
  });
});

describe("formatSLHitPreview", () => {
  test("formats the SL closure message", () => {
    expect(formatSLHitPreview({ asset: "BTCUSDT", timeframe: "1h", level: 29_500 })).toBe(
      "🛑 SL hit on BTCUSDT 1h @ 29500 — position closed",
    );
  });
});

describe("formatExpiredPreview", () => {
  test("formats the TTL expiry message", () => {
    expect(formatExpiredPreview({ asset: "BTCUSDT", timeframe: "1h" })).toBe(
      "⏱ Setup expired (TTL reached) on BTCUSDT 1h",
    );
  });
});

describe("formatInvalidatedAfterConfirmedPreview", () => {
  test("formats with reason", () => {
    const out = formatInvalidatedAfterConfirmedPreview({
      asset: "BTCUSDT",
      timeframe: "1h",
      reason: "price_below_invalidation",
    });
    expect(out).toContain("⚠️ BTCUSDT 1h invalidated post-confirmation");
    expect(out).toContain("Reason: price_below_invalidation");
  });
});
