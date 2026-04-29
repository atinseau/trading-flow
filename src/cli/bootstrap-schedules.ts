import { TemporalScheduleController } from "@adapters/temporal/TemporalScheduleController";
import { SystemClock } from "@adapters/time/SystemClock";
import { bootstrapWatch } from "@config/bootstrapWatch";
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";

const log = getLogger({ component: "bootstrap-schedules" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const infra = loadInfraConfig();
const watches = await loadWatchesConfig(configPath);

if (watches === null) {
  log.info({ configPath }, "standby: no watches.yaml — skipping schedule bootstrap");
  process.exit(0);
}

const connection = await Connection.connect({ address: infra.temporal.address });
const client = new Client({ connection, namespace: infra.temporal.namespace });

const enabled = watches.watches.filter((w) => w.enabled);
for (const watch of enabled) {
  await bootstrapWatch(watch, {
    client,
    taskQueues: infra.temporal.task_queues,
    clock: new SystemClock(),
    scheduleController: new TemporalScheduleController(client),
  });
}

log.info({ count: enabled.length }, "done");
process.exit(0);
