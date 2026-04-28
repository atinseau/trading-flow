import { Client, Connection } from "@temporalio/client";

const watchId = process.argv[2];
if (!watchId) {
  console.error("Usage: force-tick <watch-id>");
  process.exit(1);
}

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
});
const client = new Client({ connection });

await client.workflow.getHandle(`scheduler-${watchId}`).signal("doTick");
console.log(`[force-tick] sent doTick signal to scheduler-${watchId}`);
process.exit(0);
