import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StoredReplayEvent } from "@domain/ports/ReplayEventStore";
import type { ReplaySession } from "@domain/replay/ReplaySession";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  getReplayStateQuery,
  pauseSignal,
  replaySessionWorkflow,
  replaySessionWorkflowId,
  replayTickSignal,
  resumeSignal,
  terminateSignal,
} from "@workflows/replay/replaySessionWorkflow";
import { workflowBundlerOptions } from "../../../src/workers/workflowBundlerOptions";

/**
 * Integration tests for `replaySessionWorkflow` using `@temporalio/testing`.
 *
 * Strategy : fake every activity the workflow proxies (load session,
 * detector / reviewer / finalizer / feedback, append event, fetch
 * candles, update status). The workflow itself runs in the test
 * sandbox, so we get coverage on the signal/queue mechanics, the
 * detector→reviewer→finalizer→tracking pipeline, and the COMPLETED /
 * COST_CAPPED guards.
 *
 * NOTE : `TestWorkflowEnvironment.createLocal()` downloads the Temporal
 * CLI on first run. Blocked in the sandbox (403 on temporal.download)
 * but works locally — this file follows the existing pattern from
 * `test/workflows/feedback/feedbackLoopWorkflow.test.ts`.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

let __testCounter = 0;
function uniqueQueue(name: string): string {
  return `replay-${name}-${++__testCounter}`;
}

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

function makeSession(opts?: { costCapUsd?: number }): ReplaySession {
  return {
    id: sessionId,
    watchId: "btc-1h",
    name: "integration test",
    status: "READY",
    windowStartAt: new Date("2026-04-29T00:00:00Z"),
    windowEndAt: new Date("2026-04-29T05:00:00Z"),
    workflowId: `replay-session-${sessionId}`,
    configSnapshot: makeWatch(),
    lessonsMode: "current",
    feedbackMode: "skip",
    costCapUsd: opts?.costCapUsd ?? 5,
    costUsdSoFar: 0,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

type FakeActivityState = {
  appendedEvents: StoredReplayEvent[];
  detectorCalls: number;
  reviewerCalls: number;
  finalizerCalls: number;
  feedbackCalls: number;
  statusUpdates: Array<{ status: string; failureReason?: string }>;
  detectorNewSetups: Array<unknown>;
  reviewerVerdict: {
    type: string;
    scoreDelta?: number;
    reasoning?: string;
    observations?: unknown[];
    reason?: string;
  };
  finalizerDecision: {
    go: boolean;
    reasoning: string;
    entry?: number;
    stop_loss?: number;
    take_profit?: number[];
  };
  candleRangeOutput: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
};

function makeFakeActivities(state: FakeActivityState, session: ReplaySession) {
  let seq = 0;
  return {
    loadReplaySession: async () => ({ session }),
    updateReplaySessionStatus: async (input: { status: string; failureReason?: string }) => {
      state.statusUpdates.push({ status: input.status, failureReason: input.failureReason });
    },
    appendReplayEvent: async (input: {
      sessionId: string;
      event: { setupId: string | null; payload: unknown; type: string };
    }) => {
      seq += 1;
      const stored = {
        ...input.event,
        id: `evt-${seq}`,
        sessionId: input.sessionId,
        sequence: seq,
      } as unknown as StoredReplayEvent;
      state.appendedEvents.push(stored);
      return stored;
    },
    fetchRangeCandles: async () => ({ candles: state.candleRangeOutput }),
    runDetectorReplay: async () => {
      state.detectorCalls += 1;
      return {
        verdictJson: JSON.stringify({
          corroborations: [],
          new_setups: state.detectorNewSetups,
          ignore_reason: null,
        }),
        chartUri: "mem://chart-fake",
        ohlcvUri: "mem://ohlcv-fake",
        indicatorsJson: "{}",
        lastClose: 30_000,
        costUsd: 0.1,
        promptVersion: "detector_v1",
        cacheHit: false,
      };
    },
    runReviewerReplay: async () => {
      state.reviewerCalls += 1;
      return {
        verdictJson: JSON.stringify(state.reviewerVerdict),
        costUsd: 0.05,
        promptVersion: "reviewer_v1",
        provider: "fake",
        model: "fake-model",
        cacheHit: false,
      };
    },
    runFinalizerReplay: async () => {
      state.finalizerCalls += 1;
      return {
        decisionJson: JSON.stringify(state.finalizerDecision),
        costUsd: 0.08,
        promptVersion: "finalizer_v1",
        provider: "fake",
        model: "fake-model",
        cacheHit: false,
      };
    },
    runFeedbackAnalysisReplay: async () => {
      state.feedbackCalls += 1;
      return {
        skipped: true,
        summary: "",
        actions: [],
        costUsd: 0,
        promptVersion: "",
        provider: "",
        model: "",
        cacheHit: false,
      };
    },
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitForCondition: timeout");
}

async function waitForState(
  handle: {
    query: typeof env.client.workflow.getHandle extends (id: string) => infer H
      ? H extends { query: infer Q }
        ? Q
        : never
      : never;
  },
  predicate: (s: { status: string; pendingTicks: number; tickInProgress: boolean }) => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = (await (
      handle.query as (
        q: typeof getReplayStateQuery,
      ) => Promise<{ status: string; pendingTicks: number; tickInProgress: boolean }>
    )(getReplayStateQuery)) as { status: string; pendingTicks: number; tickInProgress: boolean };
    if (predicate(s)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitForState: timeout");
}

describe("replaySessionWorkflow integration", () => {
  test("step → detector tick produces a DetectorTickProcessed event flow", async () => {
    const taskQueue = uniqueQueue("step1");
    const session = makeSession();
    const state: FakeActivityState = {
      appendedEvents: [],
      detectorCalls: 0,
      reviewerCalls: 0,
      finalizerCalls: 0,
      feedbackCalls: 0,
      statusUpdates: [],
      detectorNewSetups: [],
      reviewerVerdict: { type: "NEUTRAL", observations: [] },
      finalizerDecision: { go: false, reasoning: "fake" },
      candleRangeOutput: [],
    };
    const activities = makeFakeActivities(state, session);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/replay/replaySessionWorkflow"),
      // tsconfig path aliases (@domain/*, @adapters/*, …) must be wired into
      // the workflow bundle's webpack resolver — see CLAUDE.md "Workflow
      // bundles need the TsconfigPathsPlugin". Without this, webpack fails
      // to resolve `@domain/errors` and the suite never boots.
      bundlerOptions: workflowBundlerOptions,
      activities,
    });

    const wfId = replaySessionWorkflowId(sessionId);
    const handle = await env.client.workflow.signalWithStart(replaySessionWorkflow, {
      taskQueue,
      workflowId: wfId,
      args: [{ sessionId }],
      signal: replayTickSignal,
      signalArgs: [{ tickAt: "2026-04-29T01:00:00.000Z" }],
    });

    await worker.runUntil(async () => {
      // Wait for the detector to fire and the queue to drain.
      await waitForState(
        handle,
        (s) => s.pendingTicks === 0 && !s.tickInProgress && state.detectorCalls > 0,
      );
      await handle.signal(terminateSignal, { reason: "test_done" });
      await waitForState(handle, (s) => s.status === "FAILED");
    });

    expect(state.detectorCalls).toBe(1);
    expect(state.reviewerCalls).toBe(0);
    expect(state.finalizerCalls).toBe(0);
  }, 30_000);

  test("Detector new setup → Reviewer STRENGTHEN → score above threshold → Finalizer GO", async () => {
    const taskQueue = uniqueQueue("full-pipeline");
    const session = makeSession();
    const state: FakeActivityState = {
      appendedEvents: [],
      detectorCalls: 0,
      reviewerCalls: 0,
      finalizerCalls: 0,
      feedbackCalls: 0,
      statusUpdates: [],
      detectorNewSetups: [
        {
          type: "bullish_engulfing",
          direction: "LONG",
          pattern_category: "event",
          expected_maturation_ticks: 3,
          key_levels: { invalidation: 29_500 },
          initial_score: 75,
          raw_observation: "engulfing on 1h",
        },
      ],
      reviewerVerdict: {
        type: "STRENGTHEN",
        scoreDelta: 10,
        reasoning: "Higher highs confirmed.",
        observations: [{ kind: "trend", text: "uptrend" }],
      },
      finalizerDecision: {
        go: true,
        reasoning: "Setup meets criteria.",
        entry: 30_100,
        stop_loss: 29_500,
        take_profit: [31_000],
      },
      candleRangeOutput: [],
    };
    const activities = makeFakeActivities(state, session);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/replay/replaySessionWorkflow"),
      // tsconfig path aliases (@domain/*, @adapters/*, …) must be wired into
      // the workflow bundle's webpack resolver — see CLAUDE.md "Workflow
      // bundles need the TsconfigPathsPlugin". Without this, webpack fails
      // to resolve `@domain/errors` and the suite never boots.
      bundlerOptions: workflowBundlerOptions,
      activities,
    });

    const handle = await env.client.workflow.signalWithStart(replaySessionWorkflow, {
      taskQueue,
      workflowId: replaySessionWorkflowId(sessionId),
      args: [{ sessionId }],
      signal: replayTickSignal,
      signalArgs: [{ tickAt: "2026-04-29T01:00:00.000Z" }],
    });

    await worker.runUntil(async () => {
      // First tick : detector creates the setup + reviewer STRENGTHENS it
      // (75 + 10 = 85 ≥ 80 threshold) → moves to FINALIZING → finalizer GO.
      await waitForState(
        handle,
        (s) => s.pendingTicks === 0 && !s.tickInProgress && state.finalizerCalls > 0,
      );
      await handle.signal(terminateSignal, {});
      await waitForState(handle, (s) => s.status === "FAILED");
    });

    expect(state.detectorCalls).toBe(1);
    expect(state.reviewerCalls).toBe(1);
    expect(state.finalizerCalls).toBe(1);

    const types = state.appendedEvents.map((e) => e.type);
    expect(types).toContain("SetupCreated");
    expect(types).toContain("Strengthened");
    expect(types).toContain("Confirmed");
  }, 30_000);

  test("pause / resume gates further tick processing", async () => {
    const taskQueue = uniqueQueue("pause-resume");
    const session = makeSession();
    const state: FakeActivityState = {
      appendedEvents: [],
      detectorCalls: 0,
      reviewerCalls: 0,
      finalizerCalls: 0,
      feedbackCalls: 0,
      statusUpdates: [],
      detectorNewSetups: [],
      reviewerVerdict: { type: "NEUTRAL", observations: [] },
      finalizerDecision: { go: false, reasoning: "fake" },
      candleRangeOutput: [],
    };
    const activities = makeFakeActivities(state, session);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/replay/replaySessionWorkflow"),
      // tsconfig path aliases (@domain/*, @adapters/*, …) must be wired into
      // the workflow bundle's webpack resolver — see CLAUDE.md "Workflow
      // bundles need the TsconfigPathsPlugin". Without this, webpack fails
      // to resolve `@domain/errors` and the suite never boots.
      bundlerOptions: workflowBundlerOptions,
      activities,
    });

    const handle = await env.client.workflow.signalWithStart(replaySessionWorkflow, {
      taskQueue,
      workflowId: replaySessionWorkflowId(sessionId),
      args: [{ sessionId }],
      signal: pauseSignal,
      signalArgs: [],
    });

    await worker.runUntil(async () => {
      // Workflow boots paused. Push a tick — it should NOT process.
      await handle.signal(replayTickSignal, { tickAt: "2026-04-29T01:00:00.000Z" });
      await waitForState(handle, (s) => s.status === "PAUSED" && s.pendingTicks === 1);
      expect(state.detectorCalls).toBe(0);
      // The pause signal handler must have fired an updateReplaySessionStatus
      // to keep the `replay_sessions.status` DB row in sync with the
      // workflow's in-memory status — otherwise the session endpoint stays
      // "READY" while the workflow is actually paused, and the UI shows the
      // wrong button. The handler does this as a fire-and-forget activity,
      // so we poll briefly for it to land.
      await waitForCondition(() => state.statusUpdates.some((u) => u.status === "PAUSED"), 2_000);

      // Resume → the queued tick runs.
      await handle.signal(resumeSignal);
      await waitForState(handle, (s) => s.pendingTicks === 0 && state.detectorCalls > 0);
      await waitForCondition(() => state.statusUpdates.some((u) => u.status === "READY"), 2_000);

      await handle.signal(terminateSignal, {});
      await waitForState(handle, (s) => s.status === "FAILED");
    });

    expect(state.detectorCalls).toBe(1);
    expect(state.statusUpdates.some((u) => u.status === "PAUSED")).toBe(true);
    expect(state.statusUpdates.some((u) => u.status === "READY")).toBe(true);
  }, 30_000);

  test("reaching windowEndAt → status COMPLETED + status update fired", async () => {
    const taskQueue = uniqueQueue("complete");
    const session = makeSession();
    const state: FakeActivityState = {
      appendedEvents: [],
      detectorCalls: 0,
      reviewerCalls: 0,
      finalizerCalls: 0,
      feedbackCalls: 0,
      statusUpdates: [],
      detectorNewSetups: [],
      reviewerVerdict: { type: "NEUTRAL", observations: [] },
      finalizerDecision: { go: false, reasoning: "fake" },
      candleRangeOutput: [],
    };
    const activities = makeFakeActivities(state, session);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/replay/replaySessionWorkflow"),
      // tsconfig path aliases (@domain/*, @adapters/*, …) must be wired into
      // the workflow bundle's webpack resolver — see CLAUDE.md "Workflow
      // bundles need the TsconfigPathsPlugin". Without this, webpack fails
      // to resolve `@domain/errors` and the suite never boots.
      bundlerOptions: workflowBundlerOptions,
      activities,
    });

    // Step directly to the window's end → workflow completes after the tick.
    const handle = await env.client.workflow.signalWithStart(replaySessionWorkflow, {
      taskQueue,
      workflowId: replaySessionWorkflowId(sessionId),
      args: [{ sessionId }],
      signal: replayTickSignal,
      signalArgs: [{ tickAt: session.windowEndAt.toISOString() }],
    });

    await worker.runUntil(handle.result());

    expect(state.statusUpdates.some((u) => u.status === "COMPLETED")).toBe(true);
    expect(state.detectorCalls).toBe(1);
  }, 30_000);

  test("cost cap reached → status COST_CAPPED, further phases skipped", async () => {
    const taskQueue = uniqueQueue("cost-cap");
    // Cap is exactly at one detector + one reviewer worth of cost.
    const session = makeSession({ costCapUsd: 0.14 });
    const state: FakeActivityState = {
      appendedEvents: [],
      detectorCalls: 0,
      reviewerCalls: 0,
      finalizerCalls: 0,
      feedbackCalls: 0,
      statusUpdates: [],
      detectorNewSetups: [
        {
          type: "bullish_engulfing",
          direction: "LONG",
          pattern_category: "event",
          expected_maturation_ticks: 3,
          key_levels: { invalidation: 29_500 },
          initial_score: 75,
          raw_observation: "engulfing",
        },
      ],
      reviewerVerdict: {
        type: "STRENGTHEN",
        scoreDelta: 10,
        reasoning: "ok",
        observations: [],
      },
      finalizerDecision: { go: false, reasoning: "skipped" },
      candleRangeOutput: [],
    };
    const activities = makeFakeActivities(state, session);

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("@workflows/replay/replaySessionWorkflow"),
      // tsconfig path aliases (@domain/*, @adapters/*, …) must be wired into
      // the workflow bundle's webpack resolver — see CLAUDE.md "Workflow
      // bundles need the TsconfigPathsPlugin". Without this, webpack fails
      // to resolve `@domain/errors` and the suite never boots.
      bundlerOptions: workflowBundlerOptions,
      activities,
    });

    const handle = await env.client.workflow.signalWithStart(replaySessionWorkflow, {
      taskQueue,
      workflowId: replaySessionWorkflowId(sessionId),
      args: [{ sessionId }],
      signal: replayTickSignal,
      signalArgs: [{ tickAt: "2026-04-29T01:00:00.000Z" }],
    });

    await worker.runUntil(async () => {
      // 15s: cost-cap fires only after detector + reviewer + their persistEvent
      // round-trips; the default 5s polling window is too tight when the test
      // workflow + temporal env are still warming up.
      await waitForState(handle, (s) => s.status === "COST_CAPPED", 15_000);
      // The status-flip and the updateReplaySessionStatus activity are
      // serialized in the workflow, but the query reads in-memory state and
      // can return COST_CAPPED before the activity has been recorded —
      // so wait for the activity to land before signaling terminate.
      await waitForCondition(
        () => state.statusUpdates.some((u) => u.status === "COST_CAPPED"),
        15_000,
      );
      // terminate is fire-and-forget here — once status is COST_CAPPED the
      // workflow's terminate handler keeps status as-is (per the
      // READY|PAUSED guard) and lets the main loop exit via `terminated`.
      await handle.signal(terminateSignal, {});
    });

    expect(state.detectorCalls).toBe(1);
    // detector (0.10) + reviewer (0.05) = 0.15 > cap 0.14 → COST_CAPPED
    // fires after the reviewer ; finalizer must not run.
    expect(state.reviewerCalls).toBeLessThanOrEqual(1);
    expect(state.finalizerCalls).toBe(0);
    expect(state.statusUpdates.some((u) => u.status === "COST_CAPPED")).toBe(true);
  }, 30_000);
});
