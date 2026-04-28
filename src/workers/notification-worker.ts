import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildNotificationActivities } from "@workflows/notification/activities";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "notification-worker" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const infra = loadInfraConfig();
const watches = await loadWatchesConfig(configPath);

const healthPort = Number(process.env.HEALTH_PORT ?? 8083);
const health = new HealthServer("notification-worker", healthPort);
health.start();

if (watches === null) {
  const container = await buildContainer(infra, null, "notification");
  health.setStatus("standby", { reason: "no watches.yaml — system idle, drop the file and restart" });
  log.info({ configPath }, "standby: no watches.yaml — idle (Temporal worker not registered)");
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  log.info("shutting down (standby)");
  await health.stop();
  await container.shutdown();
  process.exit(0);
}

const container = await buildContainer(infra, watches, "notification");
const connection = await NativeConnection.connect({ address: infra.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: infra.temporal.namespace,
  taskQueue: infra.temporal.task_queues.notifications,
  activities: buildNotificationActivities(container.deps),
});

log.info({ taskQueue: infra.temporal.task_queues.notifications }, "starting");

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
