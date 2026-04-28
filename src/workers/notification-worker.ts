import { loadConfig } from "@config/loadConfig";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildNotificationActivities } from "@workflows/notification/activities";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "notification-worker" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const config = await loadConfig(configPath);

const healthPort = Number(process.env.HEALTH_PORT ?? 8083);
const health = new HealthServer("notification-worker", healthPort);
health.start();

const container = await buildContainer(config, "notification");

const connection = await NativeConnection.connect({ address: config.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: config.temporal.task_queues.notifications,
  activities: buildNotificationActivities(container.deps),
});

log.info({ taskQueue: config.temporal.task_queues.notifications }, "starting");

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
