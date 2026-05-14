/**
 * Negative-corroboration parity scenario.
 *
 * Mirror image of `corroboration-positive`. Setup at score=42 receives
 * four detector decorroborations (each Δ=-8) :
 *
 *   42 → 34 → 26 → 18 → 10
 *
 * The fourth tick lands the score at exactly the dead threshold
 * (`score_threshold_dead = 10`). `applyCorroboration` flips the status
 * to `EXPIRED` on that boundary (the helper uses `<=`), so the chain
 * is four `Weakened` events with `payload.data.source = "detector_decorroboration"`,
 * the last carrying `statusAfter = "EXPIRED"`.
 *
 * Notes :
 * - `reviewer_skip_when_detector_corroborated: true` keeps the reviewer
 *   silent on every tick (the detector corroborates with a negative
 *   delta on each tick, which still counts as "corroborated" for the
 *   gating helper — see `shouldSendReviewSignal`). Both pipelines must
 *   agree on this gating behavior, or the parity comparator catches it.
 * - No finalizer tick — the setup expires before reaching the
 *   finalizer threshold.
 * - No intra-candle prices — no TRACKING phase.
 * - `setup_lifecycle.score_initial: 42` matches the seeded setup.
 */

import type { DetectorOutput } from "@domain/schemas/DetectorOutput";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { PipelineScenario } from "../types";

function detectorCorroborationOnly(
  setupId: string,
  delta: number,
  evidence: string[],
): DetectorOutput {
  const out: unknown = {
    corroborations: [{ setup_id: setupId, evidence, confidence_delta_suggested: delta }],
    new_setups: [],
    ignore_reason: null,
  };
  return out as DetectorOutput;
}

function makeWatch(): WatchConfig {
  const cfg: unknown = {
    id: "btc-parity-neg",
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
      reviewer_skip_when_detector_corroborated: true,
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

export const corroborationNegativeScenario: PipelineScenario = {
  name: "corroboration-negative",
  description:
    "Setup at score=42 + 4×(-8) decorroborations → 34 → 26 → 18 → 10 (=dead threshold) → EXPIRED",
  watch: makeWatch(),
  setup: {
    setupId: "test-setup-corrob-negative",
    direction: "LONG",
    initialScore: 42,
    invalidationLevel: 50_000,
    patternHint: "failed_breakout",
    patternCategory: "accumulation",
    expectedMaturationTicks: 3,
  },
  ticks: [
    {
      tickAt: "2026-05-14T10:00:00.000Z",
      detectorVerdict: detectorCorroborationOnly("test-setup-corrob-negative", -8, [
        "rejected_at_resistance",
      ]),
      candle: {
        open: 51_000,
        high: 51_200,
        low: 50_900,
        close: 51_100,
        timestamp: "2026-05-14T10:00:00.000Z",
      },
    },
    {
      tickAt: "2026-05-14T11:00:00.000Z",
      detectorVerdict: detectorCorroborationOnly("test-setup-corrob-negative", -8, ["volume_fade"]),
      candle: {
        open: 51_100,
        high: 51_300,
        low: 50_950,
        close: 51_050,
        timestamp: "2026-05-14T11:00:00.000Z",
      },
    },
    {
      tickAt: "2026-05-14T12:00:00.000Z",
      detectorVerdict: detectorCorroborationOnly("test-setup-corrob-negative", -8, ["lower_high"]),
      candle: {
        open: 51_050,
        high: 51_200,
        low: 50_900,
        close: 51_000,
        timestamp: "2026-05-14T12:00:00.000Z",
      },
    },
    {
      tickAt: "2026-05-14T13:00:00.000Z",
      detectorVerdict: detectorCorroborationOnly("test-setup-corrob-negative", -8, ["macd_bear"]),
      candle: {
        open: 51_000,
        high: 51_100,
        low: 50_800,
        close: 50_850,
        timestamp: "2026-05-14T13:00:00.000Z",
      },
    },
  ],
  expectedEventChain: [
    { type: "Weakened", source: "detector_decorroboration", scoreDeltaSign: -1 },
    { type: "Weakened", source: "detector_decorroboration", scoreDeltaSign: -1 },
    { type: "Weakened", source: "detector_decorroboration", scoreDeltaSign: -1 },
    {
      type: "Weakened",
      source: "detector_decorroboration",
      scoreDeltaSign: -1,
      statusAfter: "EXPIRED",
    },
  ],
};
