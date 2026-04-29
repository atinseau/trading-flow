import { bootstrapWatch } from "@config/bootstrapWatch";
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";
import pg from "pg";

const log = getLogger({ component: "bootstrap-schedules" });

const infra = loadInfraConfig();

const pool = new pg.Pool({
  connectionString: infra.database.url,
  max: 2,
  ssl: infra.database.ssl,
});

const watches = await loadWatchesFromDb(pool);
await pool.end();

const enabled = watches.filter((w) => w.enabled);

if (enabled.length === 0) {
  log.info("no enabled watches in DB — nothing to bootstrap");
  process.exit(0);
}

const connection = await Connection.connect({ address: infra.temporal.address });
const client = new Client({ connection, namespace: infra.temporal.namespace });

for (const watch of enabled) {
  await bootstrapWatch(watch, { client, taskQueues: infra.temporal.task_queues });
}

log.info({ count: enabled.length }, "done");
process.exit(0);
