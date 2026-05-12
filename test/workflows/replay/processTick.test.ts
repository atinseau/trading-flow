import { describe, expect, test } from "bun:test";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import {
  type AliveSetup,
  type ReplayActivityProxies,
  isOverCap,
  processTick,
  timeframeMinutes,
  verdictToEvent,
  withReviewerPreview,
} from "@workflows/replay/processTick";

/**
 * Unit tests for `processTick` — the pure orchestration of one replay
 * tick, extracted from `replaySessionWorkflow` so it can be tested
 * without `@temporalio/testing` (sandbox-blocked, slow locally).
 *
 * Each test wires fake activity proxies that record their calls. We
 * assert : the LLM stages are invoked in the right order, the cost-cap
 * guard short-circuits between phases, the TTL guard fires before any
 * LLM call, and the tracking simulation hooks the feedback loop on
 * close.
 */

function makeWatch(): WatchConfig {
  const cfg: unknown = {
    id: "btc-1h",
    enabled: true,
    asset: { symbol: "BTCUSDT", source: "fake" },
    timeframes: { primary: "1h", higher: [] },
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
      enabled: true,
      max_active_lessons_per_category: 30,
      injection: { detector: true, reviewer: true, finalizer: true },
      context_providers_disabled: [],
    },
    indicators: {},
  };
  return cfg as WatchConfig;
}

type CallLog = {
  detector: number;
  reviewer: number;
  finalizer: number;
  feedback: number;
  appended: Array<{ type: string; setupId: string | null }>;
  candleRange?: { from: string; to: string };
};

function makeActivities(opts: {
  log: CallLog;
  detectorNewSetups?: Array<{
    type: string;
    direction: "LONG" | "SHORT";
    pattern_category: "event" | "accumulation";
    expected_maturation_ticks?: number;
    key_levels: { invalidation: number };
    initial_score: number;
    raw_observation?: string;
  }>;
  reviewerVerdict?: {
    type: string;
    scoreDelta?: number;
    observations?: unknown[];
    reasoning?: string;
    reason?: string;
  };
  finalizerDecision?: {
    go: boolean;
    reasoning: string;
    entry?: number;
    stop_loss?: number;
    take_profit?: number[];
  };
  detectorCost?: number;
  reviewerCost?: number;
  finalizerCost?: number;
  feedbackCost?: number;
  feedbackSkipped?: boolean;
  candleRange?: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}): ReplayActivityProxies {
  let seq = 0;
  const proxies = {
    runDetectorReplay: async () => {
      opts.log.detector += 1;
      return {
        verdictJson: JSON.stringify({
          corroborations: [],
          new_setups: opts.detectorNewSetups ?? [],
          ignore_reason: null,
        }),
        chartUri: "mem://chart",
        ohlcvUri: "mem://ohlcv",
        indicatorsJson: "{}",
        lastClose: 30_000,
        costUsd: opts.detectorCost ?? 0.1,
        promptVersion: "det_v1",
        cacheHit: false,
      };
    },
    runReviewerReplay: async () => {
      opts.log.reviewer += 1;
      return {
        verdictJson: JSON.stringify(
          opts.reviewerVerdict ?? { type: "NEUTRAL", observations: [] },
        ),
        costUsd: opts.reviewerCost ?? 0.05,
        promptVersion: "rev_v1",
        provider: "fake",
        model: "fake-model",
        cacheHit: false,
      };
    },
    runFinalizerReplay: async () => {
      opts.log.finalizer += 1;
      return {
        decisionJson: JSON.stringify(
          opts.finalizerDecision ?? { go: false, reasoning: "default" },
        ),
        costUsd: opts.finalizerCost ?? 0.08,
        promptVersion: "fin_v1",
        provider: "fake",
        model: "fake-model",
        cacheHit: false,
      };
    },
    runFeedbackAnalysisReplay: async () => {
      opts.log.feedback += 1;
      return {
        skipped: opts.feedbackSkipped ?? true,
        summary: "",
        actions: [],
        costUsd: opts.feedbackCost ?? 0,
        promptVersion: "fb_v1",
        provider: "fake",
        model: "fake-model",
        cacheHit: false,
      };
    },
    appendReplayEvent: async (input: { sessionId: string; event: { type: string; setupId: string | null } }) => {
      seq += 1;
      opts.log.appended.push({ type: input.event.type, setupId: input.event.setupId });
      return {
        ...input.event,
        id: `evt-${seq}`,
        sessionId: input.sessionId,
        sequence: seq,
      } as never;
    },
    loadReplaySession: async () => ({}) as never,
    updateReplaySessionStatus: async () => undefined,
    fetchRangeCandles: async (input: { from: string; to: string }) => {
      opts.log.candleRange = { from: input.from, to: input.to };
      return { candles: opts.candleRange ?? [] };
    },
  };
  return proxies as unknown as ReplayActivityProxies;
}

function emptyLog(): CallLog {
  return { detector: 0, reviewer: 0, finalizer: 0, feedback: 0, appended: [] };
}

const sessionId = "00000000-0000-4000-8000-000000000001";

describe("isOverCap + timeframeMinutes (pure helpers)", () => {
  test("isOverCap", () => {
    expect(isOverCap(0.5, 0.4, 1)).toBe(false);
    expect(isOverCap(0.5, 0.5, 1)).toBe(true);
    expect(isOverCap(0.5, 0.6, 1)).toBe(true);
  });
  test("timeframeMinutes covers all enum values + default", () => {
    expect(timeframeMinutes("1m")).toBe(1);
    expect(timeframeMinutes("1h")).toBe(60);
    expect(timeframeMinutes("1d")).toBe(1440);
    expect(timeframeMinutes("1w")).toBe(10080);
    expect(timeframeMinutes("invalid")).toBe(60);
  });
});

describe("verdictToEvent (pure)", () => {
  test("STRENGTHEN → Strengthened payload", () => {
    const r = verdictToEvent({
      type: "STRENGTHEN",
      scoreDelta: 10,
      observations: [],
      reasoning: "ok",
    });
    expect(r.type).toBe("Strengthened");
    expect(r.payload.type).toBe("Strengthened");
  });
  test("INVALIDATE → Invalidated payload with trigger=reviewer_verdict", () => {
    const r = verdictToEvent({ type: "INVALIDATE", reason: "broken" });
    expect(r.type).toBe("Invalidated");
    if (r.payload.type === "Invalidated") {
      expect(r.payload.data.trigger).toBe("reviewer_verdict");
      expect(r.payload.data.deterministic).toBe(false);
    }
  });
});

describe("withReviewerPreview (pure)", () => {
  test("Strengthened payload gets a telegramPreview", () => {
    const out = withReviewerPreview(
      {
        type: "Strengthened",
        data: { reasoning: "ok", observations: [], source: "reviewer_full" },
      },
      {
        asset: "BTCUSDT",
        timeframe: "1h",
        scoreBefore: 60,
        scoreAfter: 70,
        includeReasoning: true,
      },
    );
    if (out.type === "Strengthened") {
      expect(out.data.telegramPreview).toContain("STRENGTHEN");
    }
  });
  test("Neutral payload is unchanged (no preview)", () => {
    const out = withReviewerPreview(
      { type: "Neutral", data: { observations: [] } },
      { asset: "X", timeframe: "1h", scoreBefore: 0, scoreAfter: 0, includeReasoning: true },
    );
    expect(out).toEqual({ type: "Neutral", data: { observations: [] } });
  });
});

describe("processTick", () => {
  test("happy path : detector → SetupCreated → reviewer STRENGTHEN → finalizer GO → Confirmed", async () => {
    const log = emptyLog();
    const activities = makeActivities({
      log,
      detectorNewSetups: [
        {
          type: "bullish_engulfing",
          direction: "LONG",
          pattern_category: "event",
          key_levels: { invalidation: 29_500 },
          initial_score: 75,
          raw_observation: "ok",
        },
      ],
      reviewerVerdict: {
        type: "STRENGTHEN",
        scoreDelta: 10,
        observations: [{ kind: "trend", text: "up" }],
        reasoning: "Higher highs confirmed.",
      },
      finalizerDecision: {
        go: true,
        reasoning: "ok",
        entry: 30_100,
        stop_loss: 29_500,
        take_profit: [31_000],
      },
    });
    const alive = new Map<string, AliveSetup>();
    const result = await processTick(
      { llm: activities, db: activities },
      {
        sessionId,
        watch: makeWatch(),
        tickAt: "2026-04-29T12:00:00.000Z",
        alive,
        prevTickAt: null,
        costSoFarBefore: 0,
        costCapUsd: 5,
        newUuid: () => "11111111-1111-4111-8111-111111111111",
      },
    );

    expect(log.detector).toBe(1);
    expect(log.reviewer).toBe(1);
    expect(log.finalizer).toBe(1);
    expect(result.costUsd).toBeCloseTo(0.23, 5); // 0.1 + 0.05 + 0.08

    const types = log.appended.map((e) => e.type);
    expect(types).toContain("SetupCreated");
    expect(types).toContain("Strengthened");
    expect(types).toContain("Confirmed");
    // DetectorTickProcessed is emitted INSIDE the runDetectorReplay activity
    // (which we stub away here), so it's NOT in this log — that's expected.
  });

  test("cost-cap guard short-circuits between phases", async () => {
    const log = emptyLog();
    const activities = makeActivities({
      log,
      detectorCost: 0.5,
      detectorNewSetups: [
        {
          type: "x",
          direction: "LONG",
          pattern_category: "event",
          key_levels: { invalidation: 29_500 },
          initial_score: 75,
          raw_observation: "",
        },
      ],
      reviewerVerdict: { type: "NEUTRAL", observations: [] },
      finalizerDecision: { go: false, reasoning: "no" },
    });
    const alive = new Map<string, AliveSetup>();
    const result = await processTick(
      { llm: activities, db: activities },
      {
        sessionId,
        watch: makeWatch(),
        tickAt: "2026-04-29T12:00:00.000Z",
        alive,
        prevTickAt: null,
        costSoFarBefore: 0,
        costCapUsd: 0.3, // detector alone exceeds the cap
        newUuid: () => "22222222-2222-4222-8222-222222222222",
      },
    );

    // Detector ran (always allowed), but reviewer + finalizer were skipped.
    expect(log.detector).toBe(1);
    expect(log.reviewer).toBe(0);
    expect(log.finalizer).toBe(0);
    expect(result.costUsd).toBeCloseTo(0.5, 5);
  });

  test("TTL expiry fires BEFORE any LLM call (no cost spent)", async () => {
    const log = emptyLog();
    const activities = makeActivities({ log });
    const expiredSetup: AliveSetup = {
      id: "expired-setup",
      snapshot: {
        id: "expired-setup",
        watchId: "btc-1h",
        asset: "BTCUSDT",
        timeframe: "1h",
        patternHint: "old",
        patternCategory: "event",
        expectedMaturationTicks: 3,
        direction: "LONG",
        currentScore: 60,
        invalidationLevel: 29_500,
      },
      runtime: {
        status: "REVIEWING",
        score: 60,
        invalidationLevel: 29_500,
        direction: "LONG",
      },
      ttlExpiresAt: new Date("2026-04-29T08:00:00.000Z"), // before tickAt
    };
    const alive = new Map([[expiredSetup.id, expiredSetup]]);

    await processTick(
      { llm: activities, db: activities },
      {
        sessionId,
        watch: makeWatch(),
        tickAt: "2026-04-29T12:00:00.000Z",
        alive,
        prevTickAt: null,
        costSoFarBefore: 0,
        costCapUsd: 5,
        newUuid: () => "33333333-3333-4333-8333-333333333333",
      },
    );

    // Detector still runs (1 call) — TTL only kills the EXPIRED setup, doesn't
    // skip the tick. But the expired setup is no longer in alive so no
    // reviewer call.
    expect(log.detector).toBe(1);
    expect(log.reviewer).toBe(0);
    expect(alive.size).toBe(0);
    const expiredEvent = log.appended.find((e) => e.type === "Expired");
    expect(expiredEvent).toBeDefined();
  });

  test("finalizer NO_GO emits Rejected and removes the setup from alive", async () => {
    const log = emptyLog();
    const activities = makeActivities({
      log,
      detectorNewSetups: [
        {
          type: "x",
          direction: "LONG",
          pattern_category: "event",
          key_levels: { invalidation: 29_500 },
          initial_score: 75,
          raw_observation: "",
        },
      ],
      reviewerVerdict: {
        type: "STRENGTHEN",
        scoreDelta: 10,
        observations: [],
        reasoning: "ok",
      },
      finalizerDecision: { go: false, reasoning: "R:R too low" },
    });
    const alive = new Map<string, AliveSetup>();
    await processTick(
      { llm: activities, db: activities },
      {
        sessionId,
        watch: makeWatch(),
        tickAt: "2026-04-29T12:00:00.000Z",
        alive,
        prevTickAt: null,
        costSoFarBefore: 0,
        costCapUsd: 5,
        newUuid: () => "44444444-4444-4444-8444-444444444444",
      },
    );

    expect(log.finalizer).toBe(1);
    const types = log.appended.map((e) => e.type);
    expect(types).toContain("Rejected");
    expect(types).not.toContain("Confirmed");
    expect(alive.size).toBe(0); // Rejected removes the setup
  });

  test("tracking simulation fires SL hit → triggers feedback analysis", async () => {
    const log = emptyLog();
    const activities = makeActivities({
      log,
      candleRange: [
        // Entry fills then SL hits in the next candle. The 2nd candle's low
        // (29_450) crosses the SL (29_500) but stays ABOVE the invalidation
        // (29_400), so only SLHit fires, not PriceInvalidated.
        { timestamp: "2026-04-29T13:00:00Z", open: 29_900, high: 30_100, low: 29_900, close: 30_050, volume: 100 },
        { timestamp: "2026-04-29T14:00:00Z", open: 30_050, high: 30_100, low: 29_450, close: 29_500, volume: 100 },
      ],
    });
    // Pre-existing TRACKING setup.
    const trackingSetup: AliveSetup = {
      id: "tracking-setup",
      snapshot: {
        id: "tracking-setup",
        watchId: "btc-1h",
        asset: "BTCUSDT",
        timeframe: "1h",
        patternHint: "x",
        patternCategory: "event",
        expectedMaturationTicks: 3,
        direction: "LONG",
        currentScore: 85,
        invalidationLevel: 29_400,
      },
      runtime: {
        status: "TRACKING",
        score: 85,
        invalidationLevel: 29_400,
        direction: "LONG",
      },
      ttlExpiresAt: new Date("2026-05-30T00:00:00Z"),
      tracking: {
        direction: "LONG",
        entry: 30_000,
        currentSL: 29_500,
        invalidationLevel: 29_400,
        sortedTPs: [30_500, 31_000],
        nextTpIndex: 0,
        entryFilled: false,
        closed: false,
        slHitAfterTp1: false,
        priceInvalidated: false,
      },
      scoreAtConfirmation: 85,
    };
    const alive = new Map([[trackingSetup.id, trackingSetup]]);

    await processTick(
      { llm: activities, db: activities },
      {
        sessionId,
        watch: makeWatch(),
        tickAt: "2026-04-29T14:00:00.000Z",
        alive,
        prevTickAt: "2026-04-29T12:00:00.000Z",
        costSoFarBefore: 0,
        costCapUsd: 5,
        newUuid: () => "55555555-5555-4555-8555-555555555555",
      },
    );

    const types = log.appended.map((e) => e.type);
    expect(types).toContain("EntryFilled");
    expect(types).toContain("SLHit");
    expect(log.feedback).toBe(1); // feedback was triggered on close
    expect(alive.size).toBe(0); // setup removed after close
  });
});
