import { forceTick } from "@config/watchOps";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";

const log = getLogger({ component: "force-tick" });

const watchId = process.argv[2];
if (!watchId) {
  log.error("Usage: force-tick <watch-id>");
  process.exit(1);
}

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
});
const client = new Client({ connection });
await forceTick({ client, watchId });
process.exit(0);
