import { loadConfig } from "@config/loadConfig";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildSetupActivities } from "@workflows/setup/activities";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "analysis-worker" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const config = await loadConfig(configPath);

const healthPort = Number(process.env.HEALTH_PORT ?? 8082);
const health = new HealthServer("analysis-worker", healthPort);
health.start();

const container = await buildContainer(config);

const connection = await NativeConnection.connect({ address: config.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: config.temporal.task_queues.analysis,
  workflowsPath: require.resolve("../workflows/setup/setupWorkflow.ts"),
  activities: buildSetupActivities(container.deps),
});

log.info({ taskQueue: config.temporal.task_queues.analysis }, "starting");

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
