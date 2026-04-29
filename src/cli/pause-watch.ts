import { pauseWatch, resumeWatch } from "@config/watchOps";
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

if (action === "pause") await pauseWatch({ client, watchId });
else await resumeWatch({ client, watchId });

process.exit(0);
