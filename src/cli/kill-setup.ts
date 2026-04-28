import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";

const log = getLogger({ component: "kill-setup" });

const setupId = process.argv[2];
const reason = process.argv.find((a) => a.startsWith("--reason="))?.slice(9) ?? "manual_close";
if (!setupId) {
  log.error("Usage: kill-setup <setup-id> [--reason=...]");
  process.exit(1);
}

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
});
const client = new Client({ connection });

await client.workflow.getHandle(`setup-${setupId}`).signal("close", { reason });
log.info({ setupId, reason }, "sent close signal");
process.exit(0);
