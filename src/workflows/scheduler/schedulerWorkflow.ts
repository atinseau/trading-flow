import {
  condition,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  startChild,
  uuid4,
} from "@temporalio/workflow";
import { type InitialEvidence, setupWorkflow } from "../setup/setupWorkflow";
import type * as schedulerActivities from "./activities";

const SHARED_NON_RETRYABLE = [
  "InvalidConfigError",
  "AssetNotFoundError",
  "LLMSchemaValidationError",
  "PromptTooLargeError",
  "NoProviderAvailableError",
  "CircularFallbackError",
  "StopRequestedError",
];

// Fetch (HTTP / Playwright render) — network is flaky, retry aggressively.
const fetchActivities = proxyActivities<
  ReturnType<typeof schedulerActivities.buildSchedulerActivities>
>({
  startToCloseTimeout: "30s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "1s",
    maximumInterval: "30s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

// LLM activities — fewer attempts, longer timeouts (LLM calls are slow + expensive).
const llmActivities = proxyActivities<
  ReturnType<typeof schedulerActivities.buildSchedulerActivities>
>({
  startToCloseTimeout: "120s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    maximumInterval: "60s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

// DB / pure-compute activities — many fast retries (transient DB blips).
const dbActivities = proxyActivities<
  ReturnType<typeof schedulerActivities.buildSchedulerActivities>
>({
  startToCloseTimeout: "10s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "100ms",
    maximumInterval: "5s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

export type SchedulerArgs = { watchId: string; analysisTaskQueue: string };

export const doTickSignal = defineSignal<[]>("doTick");
export const pauseSignal = defineSignal<[]>("pause");
export const resumeSignal = defineSignal<[]>("resume");
export const reloadConfigSignal = defineSignal<[unknown]>("reloadConfig");

export const getSchedulerStateQuery = defineQuery<{
  paused: boolean;
  lastTickAt: string | null;
}>("getSchedulerState");

export async function schedulerWorkflow(args: SchedulerArgs): Promise<void> {
  let paused = false;
  let lastTickAt: string | null = null;
  let tickInProgress = false;

  setHandler(pauseSignal, () => {
    paused = true;
  });
  setHandler(resumeSignal, () => {
    paused = false;
  });
  setHandler(reloadConfigSignal, async () => {
    await dbActivities.reloadConfigFromDb({});
  });
  setHandler(getSchedulerStateQuery, () => ({ paused, lastTickAt }));

  setHandler(doTickSignal, async () => {
    if (paused) return;
    if (tickInProgress) {
      // Skip overlapping tick — Temporal Schedule's overlap_policy:SKIP is the
      // canonical solution but we add this defense in case the schedule isn't
      // configured that way.
      return;
    }
    tickInProgress = true;
    try {
      const { costUsd } = await runOneTick(args.watchId, args.analysisTaskQueue);
      lastTickAt = new Date().toISOString();
      await dbActivities.recordWatchTick({ watchId: args.watchId, status: "success", costUsd });
    } catch {
      await dbActivities.recordWatchTick({ watchId: args.watchId, status: "failed", costUsd: 0 });
    } finally {
      tickInProgress = false;
    }
  });

  // Workflow stays alive forever, responding to signals; only terminated by
  // external cancellation (e.g. namespace shutdown).
  await condition(() => false);
}

async function runOneTick(
  watchId: string,
  analysisTaskQueue: string,
): Promise<{ costUsd: number }> {
  const { ohlcvJson } = await fetchActivities.fetchOHLCV({ watchId });
  const { indicatorsJson } = await dbActivities.computeIndicators({ ohlcvJson, watchId });
  const preFilter = await dbActivities.evaluatePreFilter({ ohlcvJson, indicatorsJson, watchId });
  if (!preFilter.passed) return { costUsd: 0 };

  const { artifactUri: chartUri } = await fetchActivities.renderChart({ ohlcvJson, watchId });
  const { artifactUri: ohlcvUri } = await dbActivities.persistOHLCVArtifact({ ohlcvJson });
  const { tickSnapshotId } = await dbActivities.createTickSnapshot({
    watchId,
    chartUri,
    ohlcvUri,
    ohlcvJson,
    indicatorsJson,
    preFilterPass: preFilter.passed,
  });

  const alive = await dbActivities.listAliveSetups({ watchId });
  const {
    verdictJson,
    costUsd: detectorCost,
    promptVersion: detectorPromptVersion,
  } = await llmActivities.runDetector({
    watchId,
    tickSnapshotId,
    aliveSetups: alive,
  });
  const verdict = JSON.parse(verdictJson) as {
    corroborations: { setup_id: string; confidence_delta_suggested: number; evidence: unknown }[];
    new_setups: {
      type: string;
      direction: "LONG" | "SHORT";
      key_levels: { invalidation: number };
      initial_score: number;
    }[];
  };

  const dedup = await dbActivities.dedupNewSetups({
    newSetupsJson: JSON.stringify(verdict.new_setups),
    aliveSetupsJson: JSON.stringify(alive),
    watchId,
  });

  for (const corr of verdict.corroborations) {
    await getExternalWorkflowHandle(`setup-${corr.setup_id}`).signal("corroborate", {
      confidenceDelta: corr.confidence_delta_suggested,
      evidence: corr.evidence,
    });
  }
  for (const corr of dedup.corroborateInstead) {
    await getExternalWorkflowHandle(`setup-${corr.setupId}`).signal("corroborate", {
      confidenceDelta: corr.confidenceDeltaSuggested,
      evidence: corr.evidence,
    });
  }

  const watch = await dbActivities.loadWatchConfig({ watchId });
  if (!watch) return { costUsd: detectorCost };
  for (const newSetup of dedup.creates) {
    const setupId = uuid4();
    const initial: InitialEvidence = {
      setupId,
      watchId,
      asset: watch.asset.symbol,
      timeframe: watch.timeframes.primary,
      patternHint: newSetup.type,
      patternCategory: newSetup.category,
      expectedMaturationTicks: newSetup.expectedMaturationTicks,
      allowSameTickFastPath: watch.optimization.allow_same_tick_fast_path,
      direction: newSetup.direction,
      invalidationLevel: newSetup.keyLevels.invalidation,
      initialScore: newSetup.initialScore,
      ttlCandles: watch.setup_lifecycle.ttl_candles,
      ttlExpiresAt: new Date(
        Date.now() + watch.setup_lifecycle.ttl_candles * 3600_000,
      ).toISOString(),
      scoreThresholdFinalizer: watch.setup_lifecycle.score_threshold_finalizer,
      scoreThresholdDead: watch.setup_lifecycle.score_threshold_dead,
      scoreMax: watch.setup_lifecycle.score_max,
      detectorPromptVersion,
      // Captured at creation time so a later watch-config edit cannot retro-
      // actively flip the feedback fate of in-flight setups.
      feedbackEnabled: watch.feedback.enabled,
      // Same defensive snapshot for the message-formatting flags so a config
      // edit between detection and reviewer verdict / confirmation cannot
      // change how a setup's notifications are rendered mid-flight.
      includeReasoning: watch.include_reasoning,
      includeChartImage: watch.include_chart_image,
      // Forwarded to the setup-created Telegram notification — non-load-
      // bearing for the workflow itself.
      rawObservation: newSetup.rawObservation,
      chartUri,
    };
    await startChild(setupWorkflow, {
      args: [initial],
      workflowId: `setup-${setupId}`,
      taskQueue: analysisTaskQueue,
      parentClosePolicy: ParentClosePolicy.ABANDON,
    });
  }

  const corroboratedIds = new Set([
    ...verdict.corroborations.map((c) => c.setup_id),
    ...dedup.corroborateInstead.map((c) => c.setupId),
  ]);
  for (const setup of alive) {
    if (!corroboratedIds.has(setup.id)) {
      await getExternalWorkflowHandle(setup.workflowId).signal("review", { tickSnapshotId });
    }
  }
  return { costUsd: detectorCost };
}

export const schedulerWorkflowId = (watchId: string) => `scheduler-${watchId}`;

/**
 * Tiny workflow that exists solely to be the action of a Temporal Schedule.
 * Schedules can only start workflows (not signal them directly), so this
 * workflow signals the long-running schedulerWorkflow on each tick.
 */
export async function tickStarterWorkflow(args: { watchId: string }): Promise<void> {
  await getExternalWorkflowHandle(schedulerWorkflowId(args.watchId)).signal(doTickSignal);
}
