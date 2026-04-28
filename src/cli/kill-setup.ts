import { Client, Connection } from "@temporalio/client";

const setupId = process.argv[2];
const reason = process.argv.find((a) => a.startsWith("--reason="))?.slice(9) ?? "manual_close";
if (!setupId) {
  console.error("Usage: kill-setup <setup-id> [--reason=...]");
  process.exit(1);
}

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
});
const client = new Client({ connection });

await client.workflow.getHandle(`setup-${setupId}`).signal("close", { reason });
console.log(`[kill-setup] sent close signal to setup-${setupId}`);
process.exit(0);
