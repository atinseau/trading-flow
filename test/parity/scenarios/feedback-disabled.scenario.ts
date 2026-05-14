/**
 * Feedback-disabled parity scenario.
 *
 * Setup at score=50, reviewer emits INVALIDATE → INVALIDATED. With
 * `feedback.enabled: false`, no `FeedbackLessonProposed` event should
 * appear in either pipeline.
 *
 * Note on coverage scope :
 * - This scenario exercises invalidation from the REVIEWING phase (no
 *   TRACKING reached). In the replay pipeline, `runFeedbackAnalysisReplay`
 *   is only called from the TRACKING-phase intra-candle simulation
 *   (`processTick` phase 6). In the live pipeline, the feedback child
 *   workflow only starts inside the TRACKING-phase `trackingResult`
 *   handler. So neither pipeline emits feedback events on this path
 *   regardless of the `feedback.enabled` flag — the assertion is
 *   "no FeedbackLessonProposed" which holds trivially here.
 * - A stricter test (start a TRACKING-phase close + verify feedback
 *   is suppressed by the flag) requires TRACKING-phase seeding,
 *   which is deferred under T12.2.
 *
 * Value : guards against regressions where invalidation paths
 * accidentally start emitting feedback proposals (e.g. if someone adds
 * a feedback hook to the reviewer-INVALIDATE branch in either
 * pipeline, this test would not catch it directly — but combined with
 * the cross-pipeline comparator the addition would surface as a drift).
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
    id: "btc-parity-feedback-disabled",
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
      // KEY : feedback disabled. Any post-close feedback emission must
      // respect this flag — neither pipeline should produce a
      // FeedbackLessonProposed event for this watch.
      enabled: false,
      max_active_lessons_per_category: 30,
      injection: { detector: true, reviewer: true, finalizer: true },
      context_providers_disabled: [],
    },
    indicators: {},
  };
  return cfg as WatchConfig;
}

export const feedbackDisabledScenario: PipelineScenario = {
  name: "feedback-disabled",
  description:
    "Setup at score=50, reviewer INVALIDATE → INVALIDATED, feedback.enabled=false → no FeedbackLessonProposed",
  watch: makeWatch(),
  setup: {
    setupId: "test-setup-feedback-disabled",
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
      reviewerVerdict: invalidateVerdict("Structure broken"),
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
