import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";

const log = getLogger({ component: "pause-watch" });

const watchId = process.argv[2];
const action = process.argv[3] ?? "pause";
if (!watchId || !["pause", "resume"].includes(action)) {
  log.error("Usage: pause-watch <watch-id> [pause|resume]");
  process.exit(1);
}

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
});
const client = new Client({ connection });

await client.workflow.getHandle(`scheduler-${watchId}`).signal(action);
log.info({ watchId, action }, "sent signal");
process.exit(0);
