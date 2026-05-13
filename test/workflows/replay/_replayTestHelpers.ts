import type { WatchConfig } from "@domain/schemas/WatchesConfig";

/**
 * Shared test helpers for the replay test suite. Avoids duplicating the
 * ~70-line `makeWatch()` builder across 4 separate test files.
 *
 * Mirrors `test/workflows/setup/_setupTestHelpers.ts` and
 * `test/workflows/feedback/_feedbackTestHelpers.ts` (where applicable)
 * for cross-suite consistency.
 */

/**
 * Builds a minimal but valid WatchConfig for the replay test suites.
 * Defaults to a naked BTC/1h watch with all stages' feedback injection
 * enabled and "fake" source/analyzer keys (the test fake market data
 * fetcher + LLM provider use these to route).
 *
 * Callers can override specific fields via `overrides` — useful when a
 * test needs a different timeframe or a custom analyzer.
 */
export function makeReplayWatch(
  overrides?: Partial<{
    id: string;
    symbol: string;
    primaryTimeframe: string;
    feedbackEnabled: boolean;
    feedbackInjection: { detector: boolean; reviewer: boolean; finalizer: boolean };
  }>,
): WatchConfig {
  const cfg: unknown = {
    id: overrides?.id ?? "btc-1h",
    enabled: true,
    asset: { symbol: overrides?.symbol ?? "BTCUSDT", source: "fake" },
    timeframes: { primary: overrides?.primaryTimeframe ?? "1h", higher: [] },
    schedule: { detector_cron: "*/15 * * * *", timezone: "UTC" },
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
    setup_lifecycle: {
      ttl_candles: 50,
      score_initial: 25,
      score_threshold_finalizer: 80,
      score_threshold_dead: 10,
      score_max: 100,
      invalidation_policy: "strict",
      min_risk_reward_ratio: 2.0,
    },
    costs: { fees_pct: 0.1, slippage_pct: 0.05 },
    history_compaction: { max_raw_events_in_context: 40, summarize_after_age_hours: 48 },
    deduplication: { similar_setup_window_candles: 5, similar_price_tolerance_pct: 0.5 },
    pre_filter: {
      enabled: true,
      mode: "lenient",
      thresholds: {
        atr_ratio_min: 1.3,
        volume_spike_min: 1.5,
        rsi_extreme_distance: 25,
        near_pivot_distance_pct: 0.3,
      },
    },
    analyzers: {
      detector: { provider: "fake", model: "fake", max_tokens: 2000 },
      reviewer: { provider: "fake", model: "fake", max_tokens: 2000 },
      finalizer: { provider: "fake", model: "fake", max_tokens: 2000 },
      feedback: { provider: "fake", model: "fake" },
    },
    optimization: { reviewer_skip_when_detector_corroborated: true },
    notify_on: [],
    include_chart_image: false,
    include_reasoning: true,
    budget: { pause_on_budget_exceeded: false },
    feedback: {
      enabled: overrides?.feedbackEnabled ?? true,
      max_active_lessons_per_category: 30,
      injection: overrides?.feedbackInjection ?? {
        detector: true,
        reviewer: true,
        finalizer: true,
      },
      context_providers_disabled: [],
    },
    indicators: {},
  };
  return cfg as WatchConfig;
}
