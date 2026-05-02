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
import type { SetupStatus } from "@domain/state-machine/setupTransitions";
import { FakeNotifier } from "@test-fakes/FakeNotifier";
import { InMemoryEventStore } from "@test-fakes/InMemoryEventStore";
import { InMemorySetupRepository } from "@test-fakes/InMemorySetupRepository";
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

// ---- killSetup activity (idempotency) ---------------------------------------

/**
 * Build a minimal ActivityDeps wired to in-memory setupRepo + eventStore so
 * we can exercise the killSetup activity's idempotency contract directly.
 */
function makeKillDeps(
  setupRepo: InMemorySetupRepository,
  eventStore: InMemoryEventStore,
): ActivityDeps {
  return {
    setupRepo,
    eventStore,
    // Unused in killSetup
    watchById: async () => null,
    notifier: null as never,
    infra: null as never,
    clock: null as never,
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

function seedSetup(
  repo: InMemorySetupRepository,
  setupId: string,
  status: SetupStatus,
): Promise<unknown> {
  return repo.create({
    id: setupId,
    watchId: "btc-1h",
    asset: "BTCUSDT",
    timeframe: "1h",
    status,
    currentScore: 25,
    patternHint: "double_bottom",
    patternCategory: "accumulation",
    expectedMaturationTicks: 4,
    invalidationLevel: 100,
    direction: "LONG",
    ttlCandles: 50,
    ttlExpiresAt: new Date(Date.now() + 365 * 24 * 3600_000),
    workflowId: "wf-test",
  });
}

/**
 * The InMemoryEventStore tracks setupUpdate in a side map but does not
 * mutate the repo (production EventStore.append does both inside one
 * tx). For the idempotency test we manually patch the repo to reflect
 * the post-append status — this is what the real Postgres tx commits.
 * Without the patch the second activity call would still observe
 * REVIEWING and fail the no-op assertion for reasons unrelated to the
 * production behavior we care about.
 */
function syncRepoFromEvent(
  repo: InMemorySetupRepository,
  store: InMemoryEventStore,
  setupId: string,
): void {
  const update = store.setupStateAfterAppend.get(setupId);
  if (!update) return;
  repo.patch(setupId, {
    status: update.status,
    currentScore: update.score,
  });
}

describe("killSetup — idempotency", () => {
  test("calling twice on the same setup persists Killed event only once", async () => {
    const repo = new InMemorySetupRepository();
    const events = new InMemoryEventStore();
    await seedSetup(repo, "kill-1", "REVIEWING");
    const activities = buildSetupActivities(makeKillDeps(repo, events));

    await activities.killSetup({ setupId: "kill-1", reason: "user_killed_via_telegram" });
    // Mirror the same-tx update that PostgresEventStore.append performs.
    syncRepoFromEvent(repo, events, "kill-1");

    // Second call must be a no-op — repo status is now KILLED (terminal).
    await activities.killSetup({ setupId: "kill-1", reason: "user_killed_via_telegram" });

    const killedEvents = events.events.filter(
      (e) => e.setupId === "kill-1" && e.type === "Killed",
    );
    expect(killedEvents).toHaveLength(1);
    expect(killedEvents[0]?.statusAfter).toBe("KILLED");
  });

  test("calling on a setup already in CONFIRMED-equivalent terminal status is a no-op", async () => {
    const repo = new InMemorySetupRepository();
    const events = new InMemoryEventStore();
    // CLOSED is the canonical post-confirm terminal status (CONFIRMED is
    // a transient finalizer event, not a status). Either covers the spec
    // intent: kill on already-terminal setup must be a no-op.
    await seedSetup(repo, "kill-2", "CLOSED");
    const activities = buildSetupActivities(makeKillDeps(repo, events));

    await activities.killSetup({ setupId: "kill-2", reason: "late_kill" });

    expect(events.events).toHaveLength(0);
    // Status preserved (no flip to KILLED).
    const after = await repo.get("kill-2");
    expect(after?.status).toBe("CLOSED");
  });

  test("calling on a setup with status REJECTED is a no-op", async () => {
    const repo = new InMemorySetupRepository();
    const events = new InMemoryEventStore();
    await seedSetup(repo, "kill-3", "REJECTED");
    const activities = buildSetupActivities(makeKillDeps(repo, events));

    await activities.killSetup({ setupId: "kill-3", reason: "late_kill" });

    expect(events.events).toHaveLength(0);
    const after = await repo.get("kill-3");
    expect(after?.status).toBe("REJECTED");
  });
});
