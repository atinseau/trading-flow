import { loadConfig } from "@config/loadConfig";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildPriceMonitorActivities } from "@workflows/price-monitor/activities";
import { buildSchedulerActivities } from "@workflows/scheduler/activities";
import { buildContainer } from "./buildContainer";

const configPath = process.argv[2] ?? "config/watches.yaml";
const config = await loadConfig(configPath);
const container = await buildContainer(config);

const connection = await NativeConnection.connect({ address: config.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: config.temporal.task_queues.scheduler,
  workflowsPath: require.resolve("../workflows/scheduler/schedulerWorkflow.ts"),
  activities: {
    ...buildSchedulerActivities(container.deps),
    ...buildPriceMonitorActivities(container.deps),
  },
});

console.log(`[scheduler-worker] starting on queue=${config.temporal.task_queues.scheduler}`);
process.on("SIGTERM", async () => {
  console.log("[scheduler-worker] shutting down");
  worker.shutdown();
  await container.shutdown();
});
await worker.run();
