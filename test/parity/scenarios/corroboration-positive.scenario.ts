/**
 * First cross-pipeline parity scenario.
 *
 * Drives the build-out of `runLive` + `runReplay` (Task 10). The scenario
 * exercises the corroboration channel — score climbs from 50 to 82 across
 * four detector ticks (each +8) until it crosses the finalizer threshold
 * on tick 3, then the finalizer issues a GO on tick 4 → TRACKING. The
 * candle on tick 4 reaches both TP levels (intra-candle high), so the
 * tracker fires `EntryFilled` → `TPHit(×2)` and closes the setup.
 *
 * The `expectedEventChain` is intentionally a SUBSET of the full chain —
 * `expectEventChain` matches in-order while skipping unrelated events
 * (TPHit, TrailingMoved, …). The cross-pipeline drift check
 * (`compareCanonical`) is what guarantees both pipelines agree on the
 * canonical event sequence.
 *
 * Notes :
 * - `reviewer_skip_when_detector_corroborated: true` keeps the reviewer
 *   silent on ticks where the detector corroborated the alive setup —
 *   simplifies the chain (no Strengthened-from-reviewer events). Both
 *   live (`schedulerWorkflow`) and replay (`processTick`) honour this
 *   flag via `shouldSendReviewSignal`.
 * - `feedback.enabled: false` keeps replay's post-close path quiet ;
 *   no `FeedbackLessonProposed` events emitted (which the canonical
 *   comparator would filter anyway, but cleaner this way).
 * - `setup_lifecycle.score_initial: 50` matches the scenario's
 *   `initialScore` so the seeded setup respects the watch's config.
 */

import type { DetectorOutput } from "@domain/schemas/DetectorOutput";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { PipelineScenario } from "../types";

/**
 * Helper to build a corroboration-only DetectorOutput without the
 * plugin-dependent `confidence_breakdown` / `clarity` fields (the
 * scenario's watch has no plugins configured, but those fields belong
 * to `new_setups`, not corroborations). Cast through `unknown` keeps
 * Biome happy without flooding the file with `as any`.
 */
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
    id: "btc-parity",
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

export const corroborationPositiveScenario: PipelineScenario = {
  name: "corroboration-positive",
  description:
    "Setup at score=50 + 4×(+8) corroborations → 82 → FINALIZING → finalizer GO → TRACKING → TPs hit",
  watch: makeWatch(),
  setup: {
    setupId: "test-setup-corrob-positive",
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
      detectorVerdict: detectorCorroborationOnly("test-setup-corrob-positive", 8, ["higher_low"]),
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
      detectorVerdict: detectorCorroborationOnly("test-setup-corrob-positive", 8, ["volume_spike"]),
      candle: {
        open: 51_100,
        high: 51_400,
        low: 51_000,
        close: 51_300,
        timestamp: "2026-05-14T11:00:00.000Z",
      },
    },
    {
      tickAt: "2026-05-14T12:00:00.000Z",
      detectorVerdict: detectorCorroborationOnly("test-setup-corrob-positive", 8, ["ema_cross"]),
      candle: {
        open: 51_300,
        high: 51_600,
        low: 51_200,
        close: 51_500,
        timestamp: "2026-05-14T12:00:00.000Z",
      },
    },
    {
      tickAt: "2026-05-14T13:00:00.000Z",
      detectorVerdict: detectorCorroborationOnly("test-setup-corrob-positive", 8, ["macd_bull"]),
      finalizerDecision: {
        go: true,
        reasoning: "Strong confluence",
        entry: 51_500,
        stop_loss: 50_500,
        take_profit: [52_500, 53_500],
      },
      candle: {
        open: 51_500,
        high: 53_800,
        low: 51_400,
        close: 53_700,
        timestamp: "2026-05-14T13:00:00.000Z",
      },
      // Intra-candle progression for the live trackingLoop. Three price
      // ticks that mirror the candle's high climbing through TP1 → TP2.
      // Replay simulates this from the candle itself (see processTick
      // phase 6) — feeding the same three prices to live as
      // trackingPrice signals so both pipelines hit the same TP events.
      intraCandlePrices: [
        { price: 51_600, observedAt: "2026-05-14T13:00:00.500Z" },
        { price: 52_600, observedAt: "2026-05-14T13:00:01.000Z" },
        { price: 53_600, observedAt: "2026-05-14T13:00:02.000Z" },
      ],
    },
  ],
  expectedEventChain: [
    { type: "Strengthened", source: "detector_corroboration", scoreDeltaSign: 1 },
    { type: "Strengthened", source: "detector_corroboration", scoreDeltaSign: 1 },
    {
      type: "Strengthened",
      source: "detector_corroboration",
      scoreDeltaSign: 1,
      statusAfter: "FINALIZING",
    },
    { type: "Confirmed", statusAfter: "TRACKING" },
  ],
};
