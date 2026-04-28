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

const container = await buildContainer(config);

const connection = await NativeConnection.connect({ address: config.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: config.temporal.task_queues.notifications,
  activities: buildNotificationActivities(container.deps),
});

log.info({ taskQueue: config.temporal.task_queues.notifications }, "starting");
process.on("SIGTERM", async () => {
  log.info("shutting down");
  worker.shutdown();
  await health.stop();
  await container.shutdown();
});
await worker.run();
