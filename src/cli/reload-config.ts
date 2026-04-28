import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const log = getLogger({ component: "reload-config" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const dryRun = process.argv.includes("--dry-run");

const infra = loadInfraConfig();
const watches = await loadWatchesConfig(configPath);

if (watches === null) {
  log.info({ configPath }, "no watches.yaml — nothing to reload");
  process.exit(0);
}

log.info({ count: watches.watches.length, configPath }, "loaded watches");

if (dryRun) {
  log.info("--dry-run, exiting before applying");
  process.exit(0);
}

const connection = await Connection.connect({ address: infra.temporal.address });
const client = new Client({ connection, namespace: infra.temporal.namespace });

for (const watch of watches.watches.filter((w) => w.enabled)) {
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
