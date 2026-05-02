/**
 * Guard tests for the new setup-lifecycle Telegram notify activities.
 *
 * The activities each gate on `watch.notify_on.includes(<event>)` — when the
 * event is not in the list the function returns null and the notifier is
 * never called. These tests verify both branches (skipped vs. sent) for
 * notifyTelegramSetupCreated, notifyTelegramReviewerVerdict (both
 * STRENGTHEN and WEAKEN paths), and notifyTelegramSetupKilled.
 *
 * No Temporal worker, no real DB — pure unit tests against a FakeNotifier.
 */
import { describe, expect, test } from "bun:test";
import type { InfraConfig } from "@config/InfraConfig";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { FakeNotifier } from "@test-fakes/FakeNotifier";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { buildSetupActivities } from "@workflows/setup/activities";

function makeWatch(overrides: Partial<WatchConfig> = {}): WatchConfig {
  return {
    id: "btc-1h",
    enabled: true,
    asset: { symbol: "BTCUSDT", source: "binance" },
    timeframes: { primary: "1h", higher: [] },
    schedule: { timezone: "UTC" },
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
    setup_lifecycle: {
      ttl_candles: 50,
      score_initial: 25,
      score_threshold_finalizer: 80,
      score_threshold_dead: 10,
      score_max: 100,
      invalidation_policy: "strict" as const,
      min_risk_reward_ratio: 2,
    },
    history_compaction: { max_raw_events_in_context: 40, summarize_after_age_hours: 48 },
    deduplication: { similar_setup_window_candles: 5, similar_price_tolerance_pct: 0.5 },
    pre_filter: {
      enabled: true,
      mode: "lenient",
      thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 },
    },
    analyzers: {
      // biome-ignore lint/suspicious/noExplicitAny: test fake provider
      detector: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
      // biome-ignore lint/suspicious/noExplicitAny: test fake provider
      reviewer: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
      // biome-ignore lint/suspicious/noExplicitAny: test fake provider
      finalizer: { provider: "fake" as any, model: "fake-model", max_tokens: 2000 },
    },
    optimization: {
      reviewer_skip_when_detector_corroborated: true,
      allow_same_tick_fast_path: true,
    },
    costs: { fees_pct: 0.1, slippage_pct: 0.05 },
    notify_on: [],
    include_chart_image: true,
    include_reasoning: true,
    budget: { pause_on_budget_exceeded: true },
    feedback: {
      enabled: false,
      max_active_lessons_per_category: 30,
      injection: { detector: false, reviewer: false, finalizer: false },
      context_providers_disabled: [],
    },
    indicators: {},
    ...overrides,
  } as WatchConfig;
}

function makeDeps(watch: WatchConfig, notifier: FakeNotifier): ActivityDeps {
  return {
    watchById: async (id) => (id === watch.id ? watch : null),
    notifier,
    infra: {
      notifications: { telegram: { chat_id: "test-chat", bot_token: "x" } },
    } as unknown as InfraConfig,
    // The rest are never reached in these tests.
    clock: null as never,
    setupRepo: null as never,
    eventStore: null as never,
    artifactStore: null as never,
    tickSnapshotStore: null as never,
    llmProviders: new Map(),
    llmCallStore: null as never,
    fundingRateProviders: new Map(),
    marketDataFetchers: new Map(),
    chartRenderer: null as never,
    indicatorCalculator: null as never,
    indicatorRegistry: null as never,
    promptBuilder: null as never,
    priceFeeds: new Map(),
    watchRepo: null as never,
    config: null as never,
    temporalClient: null as never,
    scheduleController: null as never,
    db: null as never,
    pgPool: null as never,
    lessonStore: null as never,
    lessonEventStore: null as never,
    feedbackContextRegistry: null as never,
    notifyLessonPending: null as never,
  };
}

const SETUP_ID = "11111111-1111-1111-1111-111111111111";

describe("notifyTelegramSetupCreated — notify_on guard", () => {
  test("skipped when 'setup_created' not in notify_on (returns null, notifier not called)", async () => {
    const notifier = new FakeNotifier();
    const watch = makeWatch({ notify_on: ["confirmed"] });
    const activities = buildSetupActivities(makeDeps(watch, notifier));

    const result = await activities.notifyTelegramSetupCreated({
      watchId: watch.id,
      asset: "BTCUSDT",
      timeframe: "1h",
      setupId: SETUP_ID,
      patternHint: "double_bottom",
      direction: "LONG",
      initialScore: 25,
      rawObservation: "test",
      invalidationLevel: 100,
    });

    expect(result).toBeNull();
    expect(notifier.sentMessages).toHaveLength(0);
  });

  test("sends with kill button when 'setup_created' in notify_on", async () => {
    const notifier = new FakeNotifier();
    const watch = makeWatch({ notify_on: ["setup_created"] });
    const activities = buildSetupActivities(makeDeps(watch, notifier));

    const result = await activities.notifyTelegramSetupCreated({
      watchId: watch.id,
      asset: "BTCUSDT",
      timeframe: "1h",
      setupId: SETUP_ID,
      patternHint: "double_bottom",
      direction: "LONG",
      initialScore: 25,
      rawObservation: "RSI divergence over 4 ticks",
      invalidationLevel: 100,
    });

    expect(result).not.toBeNull();
    expect(notifier.sentMessages).toHaveLength(1);
    const sent = notifier.sentMessages[0]!;
    expect(sent.text).toContain("New setup detected");
    expect(sent.text).toContain("RSI divergence over 4 ticks");
    // Kill button must be attached and target the right setupId.
    expect(sent.buttons).toBeDefined();
    expect(sent.buttons![0]![0]!.text).toContain("Kill");
    expect(sent.buttons![0]![0]!.callbackData).toContain(SETUP_ID);
  });

  test("returns null when watch is unknown", async () => {
    const notifier = new FakeNotifier();
    const watch = makeWatch({ notify_on: ["setup_created"] });
    const activities = buildSetupActivities(makeDeps(watch, notifier));
    const result = await activities.notifyTelegramSetupCreated({
      watchId: "ghost-watch",
      asset: "BTCUSDT",
      timeframe: "1h",
      setupId: SETUP_ID,
      patternHint: "double_bottom",
      direction: "LONG",
      initialScore: 25,
      rawObservation: "x",
      invalidationLevel: 100,
    });
    expect(result).toBeNull();
    expect(notifier.sentMessages).toHaveLength(0);
  });
});

describe("notifyTelegramReviewerVerdict — notify_on guard", () => {
  test("STRENGTHEN: skipped when 'setup_strengthened' not in notify_on", async () => {
    const notifier = new FakeNotifier();
    const watch = makeWatch({ notify_on: ["setup_weakened"] });
    const activities = buildSetupActivities(makeDeps(watch, notifier));

    const result = await activities.notifyTelegramReviewerVerdict({
      watchId: watch.id,
      asset: "BTCUSDT",
      timeframe: "1h",
      setupId: SETUP_ID,
      verdict: "STRENGTHEN",
      scoreDelta: 10,
      scoreAfter: 35,
      reasoning: "looks better",
    });

    expect(result).toBeNull();
    expect(notifier.sentMessages).toHaveLength(0);
  });

  test("WEAKEN: skipped when 'setup_weakened' not in notify_on", async () => {
    const notifier = new FakeNotifier();
    const watch = makeWatch({ notify_on: ["setup_strengthened"] });
    const activities = buildSetupActivities(makeDeps(watch, notifier));

    const result = await activities.notifyTelegramReviewerVerdict({
      watchId: watch.id,
      asset: "BTCUSDT",
      timeframe: "1h",
      setupId: SETUP_ID,
      verdict: "WEAKEN",
      scoreDelta: -10,
      scoreAfter: 15,
      reasoning: "fading",
    });

    expect(result).toBeNull();
    expect(notifier.sentMessages).toHaveLength(0);
  });

  test("STRENGTHEN: sends with kill button when 'setup_strengthened' in notify_on", async () => {
    const notifier = new FakeNotifier();
    const watch = makeWatch({ notify_on: ["setup_strengthened"] });
    const activities = buildSetupActivities(makeDeps(watch, notifier));

    const result = await activities.notifyTelegramReviewerVerdict({
      watchId: watch.id,
      asset: "BTCUSDT",
      timeframe: "1h",
      setupId: SETUP_ID,
      verdict: "STRENGTHEN",
      scoreDelta: 10,
      scoreAfter: 35,
      reasoning: "RSI confirms",
    });

    expect(result).not.toBeNull();
    expect(notifier.sentMessages).toHaveLength(1);
    const sent = notifier.sentMessages[0]!;
    expect(sent.text).toContain("STRENGTHEN");
    expect(sent.text).toContain("25→35"); // scoreBefore=scoreAfter-delta=25
    expect(sent.buttons).toBeDefined();
    expect(sent.buttons![0]![0]!.callbackData).toContain(SETUP_ID);
  });

  test("WEAKEN: sends when 'setup_weakened' in notify_on", async () => {
    const notifier = new FakeNotifier();
    const watch = makeWatch({ notify_on: ["setup_weakened"] });
    const activities = buildSetupActivities(makeDeps(watch, notifier));

    const result = await activities.notifyTelegramReviewerVerdict({
      watchId: watch.id,
      asset: "BTCUSDT",
      timeframe: "1h",
      setupId: SETUP_ID,
      verdict: "WEAKEN",
      scoreDelta: -10,
      scoreAfter: 15,
      reasoning: "fading",
    });

    expect(result).not.toBeNull();
    expect(notifier.sentMessages).toHaveLength(1);
    expect(notifier.sentMessages[0]!.text).toContain("WEAKEN");
  });
});

describe("notifyTelegramSetupKilled — notify_on guard", () => {
  test("skipped when 'setup_killed' not in notify_on", async () => {
    const notifier = new FakeNotifier();
    const watch = makeWatch({ notify_on: ["confirmed"] });
    const activities = buildSetupActivities(makeDeps(watch, notifier));

    const result = await activities.notifyTelegramSetupKilled({
      watchId: watch.id,
      asset: "BTCUSDT",
      timeframe: "1h",
      setupId: SETUP_ID,
    });

    expect(result).toBeNull();
    expect(notifier.sentMessages).toHaveLength(0);
  });

  test("sends without buttons when 'setup_killed' in notify_on", async () => {
    const notifier = new FakeNotifier();
    const watch = makeWatch({ notify_on: ["setup_killed"] });
    const activities = buildSetupActivities(makeDeps(watch, notifier));

    const result = await activities.notifyTelegramSetupKilled({
      watchId: watch.id,
      asset: "BTCUSDT",
      timeframe: "1h",
      setupId: SETUP_ID,
    });

    expect(result).not.toBeNull();
    expect(notifier.sentMessages).toHaveLength(1);
    const sent = notifier.sentMessages[0]!;
    expect(sent.text).toContain("killed by user");
    // Confirmation message is intentionally button-less.
    expect(sent.buttons).toBeUndefined();
  });
});
