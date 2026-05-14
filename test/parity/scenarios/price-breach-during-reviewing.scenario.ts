/**
 * Price-breach-during-reviewing parity scenario.
 *
 * Setup REVIEWING at score=42 with `invalidationLevel = 50_000` LONG.
 * Tick 1's candle dips to `low = 49_500` (breach), while the close
 * recovers to 50_300. Both pipelines must emit a single
 * `PriceInvalidated` event with `actor: "price_monitor"` and
 * `statusAfter = "INVALIDATED"`.
 *
 * Exercises :
 * - Replay : phase 0.5 of `processTick` runs `applyPriceCheck` against
 *   the candle's `low` (LONG worst-case) — the breach is detected and
 *   the canonical `PriceInvalidated` event is appended.
 * - Live : the test runner translates `intraCandlePrices` into
 *   `priceCheck` signals BEFORE the detector/reviewer signals on the
 *   tick. The workflow's `priceCheckSignal` handler runs the same
 *   `applyPriceCheck` helper and persists the same event.
 *
 * The candle's `low` (replay) and the lowest declared intra-candle
 * price (live) are designed to be the same value (49_500) so both
 * pipelines invalidate at the same observed price.
 *
 * Detector verdict on tick 1 is intentionally empty — the breach
 * must take precedence over any corroboration/reviewer activity.
 */

import type { DetectorOutput } from "@domain/schemas/DetectorOutput";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { PipelineScenario } from "../types";

function emptyDetectorVerdict(): DetectorOutput {
  const out: unknown = { corroborations: [], new_setups: [], ignore_reason: null };
  return out as DetectorOutput;
}

function makeWatch(): WatchConfig {
  const cfg: unknown = {
    id: "btc-parity-price-breach",
    enabled: true,
    asset: { symbol: "BTCUSDT", source: "fake" },
    timeframes: { primary: "1h", higher: [] },
    schedule: { detector_cron: "*/15 * * * *", timezone: "UTC" },
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
    setup_lifecycle: {
      ttl_candles: 50,
      score_initial: 42,
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
      enabled: false,
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
    optimization: {
      reviewer_skip_when_detector_corroborated: false,
      allow_same_tick_fast_path: false,
    },
    notify_on: [],
    include_chart_image: false,
    include_reasoning: false,
    budget: { pause_on_budget_exceeded: false },
    feedback: {
      enabled: false,
      max_active_lessons_per_category: 30,
      injection: { detector: true, reviewer: true, finalizer: true },
      context_providers_disabled: [],
    },
    indicators: {},
  };
  return cfg as WatchConfig;
}

export const priceBreachDuringReviewingScenario: PipelineScenario = {
  name: "price-breach-during-reviewing",
  description:
    "Setup REVIEWING at score=42, candle.low=49_500 breaches invalidation=50_000 → PriceInvalidated",
  watch: makeWatch(),
  setup: {
    setupId: "test-setup-price-breach",
    direction: "LONG",
    initialScore: 42,
    invalidationLevel: 50_000,
    patternHint: "bull_flag",
    patternCategory: "accumulation",
    expectedMaturationTicks: 3,
  },
  ticks: [
    {
      tickAt: "2026-05-14T10:00:00.000Z",
      detectorVerdict: emptyDetectorVerdict(),
      candle: {
        open: 50_200,
        high: 50_400,
        low: 49_500, // breach — below invalidationLevel for LONG
        close: 50_300,
        timestamp: "2026-05-14T10:00:00.000Z",
      },
      // Live runner consumes these as priceCheck signals BEFORE the
      // detector/reviewer fire. The breach price (49_500) matches the
      // candle.low used by replay's phase 0.5, so both pipelines
      // invalidate at the same observed price.
      intraCandlePrices: [{ price: 49_500, observedAt: "2026-05-14T10:00:00.500Z" }],
    },
  ],
  expectedEventChain: [{ type: "PriceInvalidated", statusAfter: "INVALIDATED" }],
};
