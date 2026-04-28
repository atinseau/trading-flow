import { loadConfig } from "@config/loadConfig";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildSetupActivities } from "@workflows/setup/activities";
import { buildContainer } from "./buildContainer";

const configPath = process.argv[2] ?? "config/watches.yaml";
const config = await loadConfig(configPath);
const container = await buildContainer(config);

const connection = await NativeConnection.connect({ address: config.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: config.temporal.namespace,
  taskQueue: config.temporal.task_queues.analysis,
  workflowsPath: require.resolve("../workflows/setup/setupWorkflow.ts"),
  activities: buildSetupActivities(container.deps),
});

console.log(`[analysis-worker] starting on queue=${config.temporal.task_queues.analysis}`);
process.on("SIGTERM", async () => {
  worker.shutdown();
  await container.shutdown();
});
await worker.run();
