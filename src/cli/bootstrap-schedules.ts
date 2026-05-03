import { TemporalScheduleController } from "@adapters/temporal/TemporalScheduleController";
import { SystemClock } from "@adapters/time/SystemClock";
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

// Race on cold deploys: temporalio/auto-setup brings the gRPC server up
// (passing `temporal operator cluster health`) before its async background
// task finishes provisioning the default namespace. The first describeSchedule
// call then 14 UNAVAILABLEs with "Not enough hosts to serve the request".
// Probe describeNamespace until it returns; subsequent boots are immediate
// because the namespace is persisted in postgres.
await waitForNamespaceReady(infra.temporal.namespace, { deadlineMs: 60_000 });

for (const watch of enabled) {
  await bootstrapWatch(watch, {
    client,
    taskQueues: infra.temporal.task_queues,
    clock: new SystemClock(),
    scheduleController: new TemporalScheduleController(client),
  });
}

async function waitForNamespaceReady(
  namespace: string,
  opts: { deadlineMs: number; intervalMs?: number },
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 1000;
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < opts.deadlineMs) {
    try {
      await client.workflowService.describeNamespace({ namespace });
      log.info({ namespace, waitedMs: Date.now() - start }, "namespace ready");
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Only retry the cold-start signature; surface real errors immediately.
      if (!msg.includes("UNAVAILABLE") && !msg.includes("Not enough hosts")) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(
    `Temporal namespace "${namespace}" not ready after ${opts.deadlineMs}ms: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

log.info({ count: enabled.length }, "done");
process.exit(0);
