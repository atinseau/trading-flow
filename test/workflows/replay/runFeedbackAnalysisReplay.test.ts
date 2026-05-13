import { beforeEach, describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { clearPromptCache } from "@adapters/prompts/loadPrompt";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { FewShotEngine } from "@domain/services/FewShotEngine";
import { PromptBuilder } from "@domain/services/PromptBuilder";
import { FakeChartRenderer } from "@test-fakes/FakeChartRenderer";
import { FakeIndicatorCalculator } from "@test-fakes/FakeIndicatorCalculator";
import { FakeLLMProvider } from "@test-fakes/FakeLLMProvider";
import { InMemoryArtifactStore } from "@test-fakes/InMemoryArtifactStore";
import { InMemoryLessonStore } from "@test-fakes/InMemoryLessonStore";
import { InMemoryLLMResponseCacheStore } from "@test-fakes/InMemoryLLMResponseCacheStore";
import { InMemoryReplayEventStore } from "@test-fakes/InMemoryReplayEventStore";
import { InMemoryReplayLLMCallStore } from "@test-fakes/InMemoryReplayLLMCallStore";
import { InMemoryReplaySessionRepository } from "@test-fakes/InMemoryReplaySessionRepository";
import { buildReplayActivities } from "@workflows/replay/activities";
import type { ReplayActivityDeps } from "@workflows/replay/activityDependencies";

const watchId = "btc-1h";
const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const setupId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function makeWatch(): WatchConfig {
  const cfg: unknown = {
    id: watchId,
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

type Harness = {
  deps: ReplayActivityDeps;
  llm: FakeLLMProvider;
  sessionsRepo: InMemoryReplaySessionRepository;
  replayEventStore: InMemoryReplayEventStore;
  replayLlmCallStore: InMemoryReplayLLMCallStore;
  lessonStore: InMemoryLessonStore;
};

async function buildHarness(opts: {
  feedbackMode: "run" | "skip";
  feedbackOutput?: { summary: string; actions: unknown[] };
}): Promise<Harness> {
  const watch = makeWatch();
  const sessionsRepo = new InMemoryReplaySessionRepository();
  await sessionsRepo.create({
    id: sessionId,
    watchId,
    name: "test",
    status: "READY",
    windowStartAt: new Date("2026-04-29T00:00:00Z"),
    windowEndAt: new Date("2026-04-30T00:00:00Z"),
    workflowId: `replay-session-${sessionId}`,
    configSnapshot: watch,
    lessonsMode: "current",
    feedbackMode: opts.feedbackMode,
    costCapUsd: 5,
  });

  const defaultOutput = {
    summary:
      "The setup failed because momentum stalled at the resistance level without a clean break.",
    actions: [
      {
        type: "CREATE",
        category: "reviewing",
        title: "Demand fresh volume above the prior swing high",
        body: "When price approaches the prior swing high without a notable uptick in relative volume, downgrade the confluence rating. A break that lacks participation often retraces immediately.",
        rationale:
          "Past failed setups consistently show flat volume at the contested level, despite a high reviewer score.",
      },
    ],
  };

  const llm = new FakeLLMProvider({
    name: "fake",
    available: true,
    completeImpl: async () => {
      const out = opts.feedbackOutput ?? defaultOutput;
      return {
        content: JSON.stringify(out),
        parsed: out,
        costUsd: 0.18,
        latencyMs: 600,
        promptTokens: 200,
        completionTokens: 80,
      };
    },
  });
  const llmProviders = new Map<string, LLMProvider>([["fake", llm]]);

  const indicatorRegistry = new IndicatorRegistry();
  const promptBuilder = new PromptBuilder(indicatorRegistry, new FewShotEngine());
  await promptBuilder.warmUp();

  const indicatorCalc = new FakeIndicatorCalculator();
  indicatorCalc.fixed = {};

  const deps: ReplayActivityDeps = {
    marketDataFetchers: new Map(),
    chartRenderer: new FakeChartRenderer(),
    indicatorCalculator: indicatorCalc,
    indicatorRegistry,
    promptBuilder,
    artifactStore: new InMemoryArtifactStore(),
    fundingRateProviders: new Map(),
    llmProviders,
    lessonStore: new InMemoryLessonStore(),
    sessionsRepo,
    replayEventStore: new InMemoryReplayEventStore(),
    replayLlmCallStore: new InMemoryReplayLLMCallStore(),
    cacheStore: new InMemoryLLMResponseCacheStore(),
  };

  return {
    deps,
    llm,
    sessionsRepo,
    replayEventStore: deps.replayEventStore as InMemoryReplayEventStore,
    replayLlmCallStore: deps.replayLlmCallStore as InMemoryReplayLLMCallStore,
    lessonStore: deps.lessonStore as InMemoryLessonStore,
  };
}

describe("runFeedbackAnalysisReplay", () => {
  beforeEach(() => {
    clearPromptCache();
  });

  test("feedbackMode=skip returns skipped=true without calling LLM or appending events", async () => {
    const h = await buildHarness({ feedbackMode: "skip" });
    const activities = buildReplayActivities(h.deps);

    const result = await activities.runFeedbackAnalysisReplay({
      sessionId,
      setupId,
      tickAt: "2026-04-29T18:00:00Z",
      closeReason: "sl_hit_direct",
      everConfirmed: true,
      scoreAtClose: 75,
    });

    expect(result.skipped).toBe(true);
    expect(result.actions).toEqual([]);
    expect(h.llm.callCount).toBe(0);
    expect(h.replayLlmCallStore.calls).toHaveLength(0);
    expect(h.replayEventStore.events).toHaveLength(0);
    const session = await h.sessionsRepo.get(sessionId);
    expect(session?.costUsdSoFar).toBe(0);
  });

  test("feedbackMode=run: calls LLM, records llm_call, increments cost, appends FeedbackLessonProposed events", async () => {
    const h = await buildHarness({ feedbackMode: "run" });
    const activities = buildReplayActivities(h.deps);

    const result = await activities.runFeedbackAnalysisReplay({
      sessionId,
      setupId,
      tickAt: "2026-04-29T18:00:00Z",
      closeReason: "sl_hit_direct",
      everConfirmed: true,
      scoreAtClose: 75,
    });

    expect(result.skipped).toBe(false);
    expect(result.actions).toHaveLength(1);
    expect(result.summary).toContain("momentum stalled");
    expect(h.llm.callCount).toBe(1);
    expect(h.replayLlmCallStore.calls).toHaveLength(1);
    expect(h.replayLlmCallStore.calls[0]?.stage).toBe("feedback");
    expect(h.replayLlmCallStore.calls[0]?.setupId).toBe(setupId);

    const session = await h.sessionsRepo.get(sessionId);
    expect(session?.costUsdSoFar).toBeCloseTo(0.18, 5);

    const events = await h.replayEventStore.listBySession(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("FeedbackLessonProposed");
    expect(events[0]?.stage).toBe("feedback");
    expect(events[0]?.setupId).toBe(setupId);
    const payload = events[0]?.payload as {
      type: string;
      data: { action: string; category?: string };
    };
    expect(payload.data.action).toBe("CREATE");
    // The LLM picked category "reviewing" in the default feedbackOutput ;
    // mapActionToProposedPayload must propagate it.
    expect(payload.data.category).toBe("reviewing");
  });

  test("does NOT mutate the live lessons store, even when proposals reference existing lessons", async () => {
    const existingLessonId = "11111111-1111-4111-8111-111111111111";
    const h = await buildHarness({
      feedbackMode: "run",
      feedbackOutput: {
        summary:
          "Existing lesson should be reinforced because the failure pattern matches its premise.",
        actions: [
          {
            type: "REINFORCE",
            lessonId: existingLessonId,
            reason: "The failure pattern exactly matches the lesson's described trigger.",
          },
        ],
      },
    });
    await h.lessonStore.create({
      id: existingLessonId,
      watchId,
      category: "reviewing",
      title: "Watch for stalled momentum at swing-high resistance",
      body: "Body body body body body body body body body body body body body body body body",
      rationale: "Stalled momentum body body body",
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });

    const activities = buildReplayActivities(h.deps);
    await activities.runFeedbackAnalysisReplay({
      sessionId,
      setupId,
      tickAt: "2026-04-29T18:30:00Z",
      closeReason: "sl_hit_direct",
      everConfirmed: true,
      scoreAtClose: 75,
    });

    // Live lesson must be UNCHANGED — replay must not auto-promote.
    const after = await h.lessonStore.getById(existingLessonId);
    expect(after?.timesReinforced).toBe(0);
    expect(after?.timesUsedInPrompts).toBe(0);

    // The proposal is captured in replay_events as a REINFORCE proposal.
    const events = await h.replayEventStore.listBySession(sessionId);
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as {
      type: string;
      data: { action: string; supersedesLessonId?: string };
    };
    expect(payload.data.action).toBe("REINFORCE");
    expect(payload.data.supersedesLessonId).toBe(existingLessonId);
  });

  test("REFINE proposal maps to FeedbackLessonProposed with supersedesLessonId + new title/body", async () => {
    const existing = "22222222-2222-4222-8222-222222222222";
    const h = await buildHarness({
      feedbackMode: "run",
      feedbackOutput: {
        summary: "Existing lesson must be sharpened around volume confirmation.",
        actions: [
          {
            type: "REFINE",
            lessonId: existing,
            newTitle: "Require uptick volume above the prior swing high before entry",
            newBody:
              "Refined wording — require relative volume above 1.5× the 20-period avg before treating a break as valid. Otherwise downgrade the confluence.",
            rationale:
              "The previous wording allowed marginal breaks ; the refined version is stricter.",
          },
        ],
      },
    });
    const activities = buildReplayActivities(h.deps);
    await activities.runFeedbackAnalysisReplay({
      sessionId,
      setupId,
      tickAt: "2026-04-29T18:00:00Z",
      closeReason: "sl_hit_direct",
      everConfirmed: true,
      scoreAtClose: 60,
    });
    const events = await h.replayEventStore.listBySession(sessionId);
    const payload = events[0]?.payload as {
      data: {
        action: string;
        title: string;
        body: string;
        supersedesLessonId?: string;
      };
    };
    expect(payload.data.action).toBe("REFINE");
    expect(payload.data.title).toContain("uptick volume");
    expect(payload.data.supersedesLessonId).toBe(existing);
  });

  test("DEPRECATE proposal maps to FeedbackLessonProposed with supersedesLessonId", async () => {
    const existing = "33333333-3333-4333-8333-333333333333";
    const h = await buildHarness({
      feedbackMode: "run",
      feedbackOutput: {
        summary: "An older lesson contradicts recent observations and should be retired.",
        actions: [
          {
            type: "DEPRECATE",
            lessonId: existing,
            reason: "Recent failed trades show the lesson's premise no longer holds.",
          },
        ],
      },
    });
    const activities = buildReplayActivities(h.deps);
    await activities.runFeedbackAnalysisReplay({
      sessionId,
      setupId,
      tickAt: "2026-04-29T18:00:00Z",
      closeReason: "sl_hit_direct",
      everConfirmed: true,
      scoreAtClose: 60,
    });
    const events = await h.replayEventStore.listBySession(sessionId);
    const payload = events[0]?.payload as {
      data: { action: string; supersedesLessonId?: string };
    };
    expect(payload.data.action).toBe("DEPRECATE");
    expect(payload.data.supersedesLessonId).toBe(existing);
  });
});
