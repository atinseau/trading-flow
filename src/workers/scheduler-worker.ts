import { loadConfig } from "@config/loadConfig";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildPriceMonitorActivities } from "@workflows/price-monitor/activities";
import { buildSchedulerActivities } from "@workflows/scheduler/activities";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "scheduler-worker" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const config = await loadConfig(configPath);

const healthPort = Number(process.env.HEALTH_PORT ?? 8081);
const health = new HealthServer("scheduler-worker", healthPort);
health.start();

const container = await buildContainer(config);

const connection = await NativeConnection.connect({ address: config.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: config.temporal.task_queues.scheduler,
  workflowsPath: require.resolve("../workflows/scheduler/index.ts"),
  activities: {
    ...buildSchedulerActivities(container.deps),
    ...buildPriceMonitorActivities(container.deps),
  },
});

log.info({ taskQueue: config.temporal.task_queues.scheduler }, "starting");
process.on("SIGTERM", async () => {
  log.info("shutting down");
  worker.shutdown();
  await health.stop();
  await container.shutdown();
});
await worker.run();
