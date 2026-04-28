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

const a = proxyActivities<ReturnType<typeof schedulerActivities.buildSchedulerActivities>>({
  startToCloseTimeout: "60s",
  retry: { maximumAttempts: 3 },
});

export type SchedulerArgs = { watchId: string };

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
  const stop = false;

  setHandler(pauseSignal, () => {
    paused = true;
  });
  setHandler(resumeSignal, () => {
    paused = false;
  });
  setHandler(reloadConfigSignal, () => {
    /* config rebuild on next tick via activity */
  });
  setHandler(getSchedulerStateQuery, () => ({ paused, lastTickAt }));

  setHandler(doTickSignal, async () => {
    if (paused || stop) return;
    try {
      await runOneTick(args.watchId);
      lastTickAt = new Date().toISOString();
      await a.recordWatchTick({ watchId: args.watchId, status: "success", costUsd: 0 });
    } catch {
      await a.recordWatchTick({ watchId: args.watchId, status: "failed", costUsd: 0 });
    }
  });

  await condition(() => stop);
}

async function runOneTick(watchId: string): Promise<void> {
  const { ohlcvJson } = await a.fetchOHLCV({ watchId });
  const { indicatorsJson } = await a.computeIndicators({ ohlcvJson });
  const preFilter = await a.evaluatePreFilter({ ohlcvJson, indicatorsJson, watchId });
  if (!preFilter.passed) return;

  const { artifactUri: chartUri } = await a.renderChart({ ohlcvJson, watchId });
  const { tickSnapshotId } = await a.createTickSnapshot({
    watchId,
    chartUri,
    ohlcvUri: chartUri,
    indicatorsJson,
    preFilterPass: preFilter.passed,
  });

  const alive = await a.listAliveSetups({ watchId });
  const { verdictJson } = await a.runDetector({ watchId, tickSnapshotId, aliveSetups: alive });
  const verdict = JSON.parse(verdictJson) as {
    corroborations: { setup_id: string; confidence_delta_suggested: number; evidence: unknown }[];
    new_setups: {
      type: string;
      direction: "LONG" | "SHORT";
      key_levels: { invalidation: number };
      initial_score: number;
    }[];
  };

  const dedup = await a.dedupNewSetups({
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

  const watch = await a.loadWatchConfig({ watchId });
  if (!watch) return;
  for (const newSetup of dedup.creates) {
    const setupId = uuid4();
    const initial: InitialEvidence = {
      setupId,
      watchId,
      asset: watch.asset.symbol,
      timeframe: watch.timeframes.primary,
      patternHint: newSetup.type,
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
    };
    await startChild(setupWorkflow, {
      args: [initial],
      workflowId: `setup-${setupId}`,
      taskQueue: "analysis",
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
