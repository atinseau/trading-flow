import { applyReload } from "@config/applyReload";
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";

const log = getLogger({ component: "reload-config" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const dryRun = process.argv.includes("--dry-run");

const infra = loadInfraConfig();
const watches = await loadWatchesConfig(configPath);

if (watches === null) {
  log.info({ configPath }, "standby: no watches.yaml — nothing to reload");
  process.exit(0);
}

log.info({ count: watches.watches.length }, "loaded watches");

if (dryRun) {
  log.info("--dry-run, exiting before applying");
  process.exit(0);
}

const connection = await Connection.connect({ address: infra.temporal.address });
const client = new Client({ connection, namespace: infra.temporal.namespace });

for (const watch of watches.watches.filter((w) => w.enabled)) {
  try {
    await applyReload({ client, watch, previous: null });
  } catch (err) {
    log.warn({ watchId: watch.id, err: (err as Error).message }, "could not reload");
  }
}

log.info("done");
process.exit(0);
