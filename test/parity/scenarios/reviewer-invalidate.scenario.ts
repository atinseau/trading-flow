/**
 * Reviewer-invalidate parity scenario.
 *
 * Setup at score=50 with no detector corroboration on tick 1. The
 * reviewer fires with `INVALIDATE` verdict, flipping the setup to
 * `INVALIDATED` and persisting an `Invalidated` event (source :
 * `reviewer_verdict`, trigger : `reviewer_verdict`).
 *
 * Exercises :
 * - Replay : `processTick` phase 4 runs the reviewer (gating bypassed
 *   because there's no corroboration), `applyVerdict` returns
 *   `INVALIDATED`, `verdictToEvent` builds the `Invalidated` payload.
 * - Live : `reviewSignal` handler runs the reviewer activity (per-tick
 *   override returns INVALIDATE), `applyVerdict` + `verdictToEvent`
 *   produce the same event.
 *
 * Notes :
 * - `reviewer_skip_when_detector_corroborated: false` keeps things
 *   simple — the reviewer fires unconditionally. The detector verdict
 *   is intentionally empty (no corroborations, no new_setups) to
 *   isolate the reviewer path.
 * - Live runner uses the per-tick `currentReviewTickIdx` mechanism
 *   added in T11.3 to surface `INVALIDATE` to the reviewer stub.
 * - `feedback.enabled: false` keeps replay's post-close path quiet.
 */

import type { DetectorOutput } from "@domain/schemas/DetectorOutput";
import type { Verdict } from "@domain/schemas/Verdict";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { PipelineScenario } from "../types";

function emptyDetectorVerdict(): DetectorOutput {
  const out: unknown = { corroborations: [], new_setups: [], ignore_reason: null };
  return out as DetectorOutput;
}

function invalidateVerdict(reason: string): Verdict {
  return { type: "INVALIDATE", reason };
}

function makeWatch(): WatchConfig {
  const cfg: unknown = {
    id: "btc-parity-rev-inv",
    enabled: true,
    asset: { symbol: "BTCUSDT", source: "fake" },
    timeframes: { primary: "1h", higher: [] },
    schedule: { detector_cron: "*/15 * * * *", timezone: "UTC" },
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
    setup_lifecycle: {
      ttl_candles: 50,
      score_initial: 50,
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

export const reviewerInvalidateScenario: PipelineScenario = {
  name: "reviewer-invalidate",
  description: "Setup at score=50 + reviewer INVALIDATE on tick 1 → INVALIDATED",
  watch: makeWatch(),
  setup: {
    setupId: "test-setup-reviewer-invalidate",
    direction: "LONG",
    initialScore: 50,
    invalidationLevel: 50_000,
    patternHint: "bull_flag",
    patternCategory: "accumulation",
    expectedMaturationTicks: 3,
  },
  ticks: [
    {
      tickAt: "2026-05-14T10:00:00.000Z",
      detectorVerdict: emptyDetectorVerdict(),
      reviewerVerdict: invalidateVerdict("Structure broken — invalidation"),
      candle: {
        open: 51_000,
        high: 51_200,
        low: 50_900,
        close: 51_100,
        timestamp: "2026-05-14T10:00:00.000Z",
      },
    },
  ],
  expectedEventChain: [{ type: "Invalidated", statusAfter: "INVALIDATED" }],
};
