import { loadConfig } from "@config/loadConfig";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const log = getLogger({ component: "reload-config" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const dryRun = process.argv.includes("--dry-run");

const config = await loadConfig(configPath);
log.info({ count: config.watches.length, configPath }, "loaded watches");

if (dryRun) {
  log.info("--dry-run, exiting before applying");
  process.exit(0);
}

const connection = await Connection.connect({ address: config.temporal.address });
const client = new Client({ connection, namespace: config.temporal.namespace });

for (const watch of config.watches.filter((w) => w.enabled)) {
  const watchLog = log.child({ watchId: watch.id });
  try {
    await client.workflow.getHandle(schedulerWorkflowId(watch.id)).signal("reloadConfig", watch);
    watchLog.info("sent reloadConfig");
  } catch (err) {
    watchLog.warn({ err: (err as Error).message }, "could not reload");
  }
}

log.info("done. Note: cron schedule changes require running bootstrap-schedules again.");
process.exit(0);
