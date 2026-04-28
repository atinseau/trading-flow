import { loadConfig } from "@config/loadConfig";
import { Client, Connection } from "@temporalio/client";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const configPath = process.argv[2] ?? "config/watches.yaml";
const dryRun = process.argv.includes("--dry-run");

const config = await loadConfig(configPath);
console.log(`[reload-config] loaded ${config.watches.length} watches from ${configPath}`);

if (dryRun) {
  console.log("[reload-config] --dry-run, exiting before applying");
  process.exit(0);
}

const connection = await Connection.connect({ address: config.temporal.address });
const client = new Client({ connection, namespace: config.temporal.namespace });

for (const watch of config.watches.filter((w) => w.enabled)) {
  try {
    await client.workflow.getHandle(schedulerWorkflowId(watch.id)).signal("reloadConfig", watch);
    console.log(`[reload-config] sent reloadConfig to ${watch.id}`);
  } catch (err) {
    console.warn(`[reload-config] could not reload ${watch.id}: ${(err as Error).message}`);
  }
}

console.log(
  "[reload-config] done. Note: cron schedule changes require running bootstrap-schedules again.",
);
process.exit(0);
