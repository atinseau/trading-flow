import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { type InitialEvidence, setupWorkflow } from "@workflows/setup/setupWorkflow";
import {
  baseRunReviewerReturn,
  defaultActivityStubs,
  makePersistEvent,
} from "../../workflows/setup/_setupTestHelpers";
import type { CapturedEvent, PipelineScenario } from "../types";

/**
 * Run a `PipelineScenario` against the live pipeline.
 *
 * Strategy : spin up a fresh `Worker` on the shared `TestWorkflowEnvironment`
 * with fake activities that replay the scenario's verdicts. Then start a
 * `setupWorkflow` for `scenario.setup` and fan in the per-tick signals
 * (`corroborate`, `review`, `trackingPrice`) in the same order the
 * scheduler would.
 *
 * Key behaviors :
 * - The scheduler's reviewer-gating logic is replicated here :
 *   `reviewer_skip_when_detector_corroborated: true` + a detector
 *   corroboration on a tick → no `review` signal sent.
 * - `runFinalizer` is overridden per scenario tick so the decision is
 *   deterministic. We pick the LATEST tick's `finalizerDecision` (the
 *   only tick that should trigger the finalizer is the one where the
 *   score crosses the threshold).
 * - Intra-candle prices declared on a tick are sent as
 *   `trackingPrice` signals after the workflow enters TRACKING. The
 *   replay runner simulates these from the candle's high/low — we
 *   feed them explicitly to live so both pipelines exit the trade at
 *   the same price levels.
 *
 * The captured events array uses the same shape as `runReplay` so
 * `compareCanonical` can diff them apples-to-apples.
 */
export async function runLive(
  scenario: PipelineScenario,
  env: TestWorkflowEnvironment,
): Promise<CapturedEvent[]> {
  const events: CapturedEvent[] = [];
  const taskQueue = `parity-${scenario.name}-${Date.now()}`;

  // Pick a finalizer decision from the scenario : we use the first tick
  // that declares one. Scenarios that have multiple decisions across
  // ticks are out of scope for this runner — fail loudly so it's not
  // silently surprising.
  const finalizerTick = scenario.ticks.find((t) => t.finalizerDecision);
  if (scenario.ticks.filter((t) => t.finalizerDecision).length > 1 && finalizerTick !== undefined) {
    throw new Error(
      "runLive does not support scenarios with multiple finalizerDecisions per setup — " +
        "the live finalizer runs at most once per setup lifecycle.",
    );
  }

  // Per-tick reviewer verdict. The live workflow's `runReviewer` activity
  // is a single function reference, but we want to vary the returned
  // verdict per tick. Track which tick is currently being processed via
  // a closure (`currentReviewTickIdx`) ; the runner sets it BEFORE
  // signaling `review` and the stub reads it on activity invocation.
  // This is preferable to a "call count" because the reviewer is gated
  // (skipped on corroborated ticks) — a call counter would drift if
  // reviewerSkipOnCorroborate is on.
  let currentReviewTickIdx = -1;

  const fakeActivities = {
    ...defaultActivityStubs(),
    persistEvent: makePersistEvent((input) => {
      const ev = input.event as {
        setupId: string;
        type: string;
        stage: string;
        actor: string;
        scoreDelta?: number;
        scoreAfter?: number;
        statusBefore?: string;
        statusAfter?: string;
        payload?: { type?: string; data?: Record<string, unknown> };
      };
      const payloadData = (ev.payload?.data ?? {}) as { source?: string };
      events.push({
        setupId: ev.setupId,
        type: ev.type,
        stage: ev.stage,
        actor: ev.actor,
        scoreDelta: ev.scoreDelta ?? 0,
        scoreAfter: ev.scoreAfter ?? 0,
        statusBefore: (ev.statusBefore ?? null) as CapturedEvent["statusBefore"],
        statusAfter: (ev.statusAfter ?? null) as CapturedEvent["statusAfter"],
        payloadType: ev.payload?.type ?? ev.type,
        payloadSource: payloadData.source,
        // Wall-clock — used only for ordering in the captured trace ; the
        // canonical comparator does NOT compare timestamps because live and
        // replay use different time bases.
        occurredAt: new Date().toISOString(),
      });
    }),
    runReviewer: async () => {
      // Per-tick override : the runner sets currentReviewTickIdx before
      // sending the `review` signal. If no override is declared on that
      // tick (or the index isn't set yet — happens during fast-path or
      // workflow-internal review calls), default to NEUTRAL.
      const tick = scenario.ticks[currentReviewTickIdx];
      const verdict = tick?.reviewerVerdict ?? { type: "NEUTRAL", observations: [] };
      return baseRunReviewerReturn(verdict);
    },
    runFinalizer: async () => {
      if (!finalizerTick?.finalizerDecision) {
        return {
          decisionJson: JSON.stringify({ go: false, reasoning: "no-decision-in-scenario" }),
          costUsd: 0,
          promptVersion: "finalizer_v4",
        };
      }
      return {
        decisionJson: JSON.stringify(finalizerTick.finalizerDecision),
        costUsd: 0,
        promptVersion: "finalizer_v4",
      };
    },
  };

  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve("@workflows/setup/setupWorkflow"),
    activities: fakeActivities,
  });

  const reviewerSkipOnCorroborate =
    scenario.watch.optimization?.reviewer_skip_when_detector_corroborated ?? false;
  const firstTickAtMs = Date.parse(scenario.ticks[0]?.tickAt ?? new Date().toISOString());
  const initial: InitialEvidence = {
    setupId: scenario.setup.setupId,
    watchId: scenario.watch.id,
    asset: scenario.watch.asset.symbol,
    timeframe: scenario.watch.timeframes.primary,
    patternHint: scenario.setup.patternHint,
    patternCategory: scenario.setup.patternCategory,
    expectedMaturationTicks: scenario.setup.expectedMaturationTicks,
    allowSameTickFastPath: false,
    direction: scenario.setup.direction,
    invalidationLevel: scenario.setup.invalidationLevel,
    initialScore: scenario.setup.initialScore,
    ttlCandles: scenario.watch.setup_lifecycle.ttl_candles,
    // Long TTL to keep the workflow alive throughout the scenario — the
    // setupWorkflow tests use 1y for the same reason (avoids race with
    // simulated time).
    ttlExpiresAt: new Date(firstTickAtMs + 365 * 24 * 3600_000).toISOString(),
    scoreThresholdFinalizer: scenario.watch.setup_lifecycle.score_threshold_finalizer,
    scoreThresholdDead: scenario.watch.setup_lifecycle.score_threshold_dead,
    scoreMax: scenario.watch.setup_lifecycle.score_max,
    detectorPromptVersion: "detector_v6",
    feedbackEnabled: scenario.watch.feedback.enabled,
    includeReasoning: scenario.watch.include_reasoning,
    includeChartImage: scenario.watch.include_chart_image,
    rawObservation: "Parity-runner seed",
  };

  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start(setupWorkflow, {
      args: [initial],
      workflowId: `parity-${scenario.name}-${Date.now()}`,
      taskQueue,
    });

    // Wait until SetupCreated has been persisted and the workflow has
    // entered REVIEWING before fanning in any signal. Sending corroborations
    // before REVIEWING would race the SetupCreated persist + early
    // applyKillIfRequested poll, leading to non-deterministic event ordering
    // (the SetupCreated event would appear AFTER several Strengthened
    // events). Mirrors the wait-for-REVIEWING pattern in setupWorkflow.test.ts.
    await waitForStatus(handle, "REVIEWING", 10_000);

    // For each scenario tick, fan in the matching signal(s).
    let expectedScore = scenario.setup.initialScore;
    for (let tickIdx = 0; tickIdx < scenario.ticks.length; tickIdx++) {
      const tick = scenario.ticks[tickIdx];
      if (!tick) continue;
      const corroborations = tick.detectorVerdict.corroborations ?? [];
      const targetCorroboration = corroborations.find((c) => c.setup_id === scenario.setup.setupId);

      // Pre-detector price-breach check (mirrors replay's phase 0.5).
      // If the scenario declares intraCandlePrices AND the workflow is
      // currently in REVIEWING/FINALIZING (= pre-TRACK), we send each
      // price as a `priceCheck` signal so the workflow's
      // priceCheckSignal handler can invalidate on a breach. After the
      // workflow enters TRACKING, intra-candle prices flow through
      // `trackingPrice` instead (see TRACKING-phase block below).
      if (tick.intraCandlePrices && tick.intraCandlePrices.length > 0) {
        const preState = await handle.query<{ status: string }>("getState");
        if (preState.status === "REVIEWING" || preState.status === "FINALIZING") {
          for (const p of tick.intraCandlePrices) {
            await handle.signal("priceCheck", {
              currentPrice: p.price,
              observedAt: p.observedAt,
            });
          }
          // Let any priceCheck-driven INVALIDATED transition settle
          // before issuing detector/reviewer signals that would
          // short-circuit on the new status.
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      // Apply detector corroboration first (matches schedulerWorkflow order :
      // corroborations are processed before review signals on the same tick).
      if (targetCorroboration && targetCorroboration.confidence_delta_suggested !== 0) {
        const delta = targetCorroboration.confidence_delta_suggested;
        await handle.signal("corroborate", {
          confidenceDelta: delta,
          evidence: targetCorroboration.evidence ?? [],
        });
        // Wait for the corroboration to land in workflow state before
        // sending the next one. Without this, four corroborate signals fire
        // concurrently and Temporal's cooperative scheduler interleaves the
        // handlers — each handler reads the post-mutation score of the
        // PREVIOUS handler (the race-fix ensures state mutates before the
        // persist await), but the `persistEvent` callbacks may resolve out
        // of arrival order, captureing events with non-monotonic
        // `statusBefore`/`statusAfter`. Polling here serializes the chain.
        expectedScore = Math.max(
          0,
          Math.min(scenario.watch.setup_lifecycle.score_max, expectedScore + delta),
        );
        await waitForScore(handle, expectedScore, 5_000);
      }

      // Reviewer signal — gated by the same `shouldSendReviewSignal` logic
      // the scheduler uses. If the detector corroborated this setup AND the
      // optimization flag is on, the reviewer is skipped.
      const skipReview = reviewerSkipOnCorroborate && targetCorroboration !== undefined;
      if (!skipReview && tick.reviewerVerdict) {
        // Tell the runReviewer stub which tick it's serving. The stub
        // closes over `currentReviewTickIdx` and reads
        // `scenario.ticks[idx].reviewerVerdict` on invocation.
        currentReviewTickIdx = tickIdx;
        await handle.signal("review", { tickSnapshotId: `snap-${tick.tickAt}` });
        // Wait for the reviewer to land before proceeding. The
        // `review` handler runs `runReviewer` then persists an event,
        // mutating `state.status` / `state.score`. If we don't wait,
        // the subsequent `close` signal (sent below) may flip state to
        // CLOSED before the reviewer persists, causing the persisted
        // event to have `statusBefore = "CLOSED"` instead of the
        // expected "REVIEWING" — a real cross-pipeline drift.
        await waitForReviewerSettled(handle, tick.reviewerVerdict.type, 10_000);
      }

      // Intra-candle tracking prices : sent only AFTER the workflow has
      // transitioned to TRACKING (i.e. after the finalizer GO'd this tick).
      // We poll the workflow state briefly to wait for TRACKING before
      // sending — mirrors the pattern in setupWorkflow.test.ts.
      //
      // Skip if the pre-detector priceCheck pass already invalidated the
      // setup (price-breach-during-reviewing scenario) or if any other
      // terminal transition happened on this tick.
      if (tick.intraCandlePrices && tick.intraCandlePrices.length > 0) {
        const postState = await handle.query<{ status: string }>("getState");
        if (postState.status === "TRACKING" || postState.status === "FINALIZING") {
          await waitForStatus(handle, "TRACKING", 10_000);
          for (const p of tick.intraCandlePrices) {
            await handle.signal("trackingPrice", {
              currentPrice: p.price,
              observedAt: p.observedAt,
            });
          }
        }
      }
    }

    // If the workflow is still alive (no terminal transition happened),
    // close it explicitly so worker.runUntil drains cleanly. If it
    // already terminated (CLOSED / REJECTED / INVALIDATED / EXPIRED),
    // the signal call throws WorkflowNotFoundError — swallow it, the
    // workflow already finished and `handle.result()` will resolve.
    try {
      await handle.signal("close", { reason: "parity-runner-done" });
    } catch {
      // workflow already terminal — ignore
    }
    await handle.result();
  });

  return events;
}

/**
 * Polls the workflow state until it reaches the target status or the
 * timeout elapses. Mirrors the wait-for-TRACKING pattern in
 * `setupWorkflow.test.ts`. Throws on timeout so a hung scenario fails
 * loudly instead of silently dropping intra-candle prices.
 */
async function waitForStatus(
  handle: { query: <T>(name: string) => Promise<T> },
  target: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await handle.query<{ status: string }>("getState");
    if (state.status === target) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for workflow status=${target} after ${timeoutMs}ms`);
}

/**
 * Polls the workflow until `state.score` reaches `target`. Used between
 * sequential corroborate signals so each signal lands on a stable
 * (post-prior-mutation) state instead of racing concurrent handlers.
 */
async function waitForScore(
  handle: { query: <T>(name: string) => Promise<T> },
  target: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await handle.query<{ score: number }>("getState");
    if (state.score === target) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timeout waiting for workflow score=${target} after ${timeoutMs}ms`);
}

/**
 * Polls the workflow until the reviewer's effect on workflow state is
 * observable. The shape of "settled" depends on the verdict type :
 *
 * - INVALIDATE → status becomes INVALIDATED.
 * - STRENGTHEN/WEAKEN → score moves OR status flips (to FINALIZING /
 *   EXPIRED). Since we don't track the expected score change here,
 *   we wait for any of {FINALIZING, EXPIRED, INVALIDATED} OR a brief
 *   timeout (the persist activity is fast).
 * - NEUTRAL → no state change ; just sleep briefly to let the persist
 *   activity drain.
 *
 * This is heuristic but adequate for the parity harness — the goal is
 * to avoid sending the `close` signal between the reviewer's
 * `runReviewer` activity completing and its `persistEvent` call,
 * which would cause the persisted event to carry the wrong
 * `statusBefore` (CLOSED instead of the expected REVIEWING).
 */
async function waitForReviewerSettled(
  handle: { query: <T>(name: string) => Promise<T> },
  verdictType: string,
  timeoutMs: number,
): Promise<void> {
  if (verdictType === "INVALIDATE") {
    await waitForStatus(handle, "INVALIDATED", timeoutMs);
    return;
  }
  // For STRENGTHEN/WEAKEN/NEUTRAL we don't have a precise post-state
  // to check (NEUTRAL doesn't mutate state at all). A short bounded
  // sleep is sufficient — the persist activity is in-memory in the
  // test environment.
  const start = Date.now();
  while (Date.now() - start < 500) {
    const state = await handle.query<{ status: string }>("getState");
    if (state.status !== "REVIEWING") return;
    await new Promise((r) => setTimeout(r, 25));
  }
}
