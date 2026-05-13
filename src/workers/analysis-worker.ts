import { PostgresLLMResponseCacheStore } from "@adapters/persistence/PostgresLLMResponseCacheStore";
import { PostgresReplayEventStore } from "@adapters/persistence/PostgresReplayEventStore";
import { PostgresReplayLLMCallStore } from "@adapters/persistence/PostgresReplayLLMCallStore";
import { PostgresReplaySessionRepository } from "@adapters/persistence/PostgresReplaySessionRepository";
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildFeedbackActivities } from "@workflows/feedback/activities";
import { buildReplayActivities } from "@workflows/replay/activities";
import type { ReplayActivityDeps } from "@workflows/replay/activityDependencies";
import { buildSetupActivities } from "@workflows/setup/activities";
import pg from "pg";
import { buildContainer } from "./buildContainer";
import { workflowBundlerOptions } from "./workflowBundlerOptions";

const log = getLogger({ component: "analysis-worker" });

const infra = loadInfraConfig();

const healthPort = Number(process.env.HEALTH_PORT ?? 8082);
const health = new HealthServer("analysis-worker", healthPort);
health.start();

const bootstrapPool = new pg.Pool({
  connectionString: infra.database.url,
  max: 2,
  ssl: infra.database.ssl,
});
const watches = await loadWatchesFromDb(bootstrapPool);
await bootstrapPool.end();

const container = await buildContainer(infra, watches, "analysis");
const connection = await NativeConnection.connect({ address: infra.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: infra.temporal.namespace,
  taskQueue: infra.temporal.task_queues.analysis,
  // setupWorkflow.ts re-exports feedbackLoopWorkflow so this single bundle
  // ships both the parent and the child workflow definitions (Phase 9).
  workflowsPath: require.resolve("../workflows/setup/setupWorkflow.ts"),
  bundlerOptions: workflowBundlerOptions,
  activities: {
    ...buildSetupActivities(container.deps),
    ...buildFeedbackActivities(container.deps),
  },
});

// ---- Replay worker -----------------------------------------------------------
// Replay shares the same process as analysis (spec §128 of the implementation
// plan : "registers replaySessionWorkflow + replay-scoped activity deps on the
// analysis-worker"). The workflow bundle is separate (own workflowsPath) but
// the heavy adapters (chartRenderer, indicatorRegistry, llmProviders,
// marketDataFetchers, lessonStore) are shared with the live activities — only
// the replay-scoped persistence stores are spun up here.
const replayDeps: ReplayActivityDeps = {
  marketDataFetchers: container.deps.marketDataFetchers,
  chartRenderer: container.deps.chartRenderer,
  indicatorCalculator: container.deps.indicatorCalculator,
  indicatorRegistry: container.deps.indicatorRegistry,
  promptBuilder: container.deps.promptBuilder,
  artifactStore: container.deps.artifactStore,
  fundingRateProviders: container.deps.fundingRateProviders,
  llmProviders: container.deps.llmProviders,
  lessonStore: container.deps.lessonStore,
  sessionsRepo: new PostgresReplaySessionRepository(container.deps.db),
  replayEventStore: new PostgresReplayEventStore(container.deps.db),
  replayLlmCallStore: new PostgresReplayLLMCallStore(container.deps.db),
  cacheStore: new PostgresLLMResponseCacheStore(container.deps.db),
};

const replayWorker = await Worker.create({
  connection,
  namespace: infra.temporal.namespace,
  taskQueue: infra.temporal.task_queues.replay,
  workflowsPath: require.resolve("../workflows/replay/replaySessionWorkflow.ts"),
  bundlerOptions: workflowBundlerOptions,
  activities: buildReplayActivities(replayDeps),
});

log.info(
  {
    taskQueue: infra.temporal.task_queues.analysis,
    replayTaskQueue: infra.temporal.task_queues.replay,
    watchCount: watches.length,
  },
  "starting",
);

const healthTick = setInterval(() => {
  const states = [worker.getState(), replayWorker.getState()];
  const downed = states.find((s) => s === "FAILED" || s === "STOPPED");
  const degraded = states.find((s) => s === "DRAINING" || s === "DRAINED" || s === "STOPPING");
  if (downed) {
    health.setStatus("down", { workerStatus: downed });
  } else if (degraded) {
    health.setStatus("degraded", { workerStatus: degraded });
  } else {
    health.setStatus("ok", { workerStatus: states.join(",") });
  }
  health.setActivity();
}, 5_000);

process.on("SIGTERM", async () => {
  log.info("shutting down");
  clearInterval(healthTick);
  health.setStatus("down");
  await health.stop();
  worker.shutdown();
  replayWorker.shutdown();
  await container.shutdown();
});
// Run both workers concurrently — each polls its own task queue. Returning
// only when both have drained / shut down ensures container.shutdown above
// runs after both workers finish in-flight tasks.
await Promise.all([worker.run(), replayWorker.run()]);
