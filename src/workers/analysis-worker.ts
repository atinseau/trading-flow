import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildSetupActivities } from "@workflows/setup/activities";
import pg from "pg";
import { buildContainer } from "./buildContainer";

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
  workflowsPath: require.resolve("../workflows/setup/setupWorkflow.ts"),
  activities: buildSetupActivities(container.deps),
});

log.info(
  { taskQueue: infra.temporal.task_queues.analysis, watchCount: watches.length },
  "starting",
);

const healthTick = setInterval(() => {
  const runState = worker.getState();
  if (runState === "FAILED" || runState === "STOPPED") {
    health.setStatus("down", { workerStatus: runState });
  } else if (runState === "DRAINING" || runState === "DRAINED" || runState === "STOPPING") {
    health.setStatus("degraded", { workerStatus: runState });
  } else {
    health.setStatus("ok", { workerStatus: runState });
  }
  health.setActivity();
}, 5_000);

process.on("SIGTERM", async () => {
  log.info("shutting down");
  clearInterval(healthTick);
  health.setStatus("down");
  await health.stop();
  worker.shutdown();
  await container.shutdown();
});
await worker.run();
