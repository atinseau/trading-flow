// One-shot script to verify ensurePriceMonitorStarted: should spawn the
// monitor on first call (idempotent) and no-op on subsequent calls.
import { loadInfraConfig } from "@config/InfraConfig";
import { getLogger } from "@observability/logger";
import { ensurePriceMonitorStarted } from "@workflows/price-monitor/ensureRunning";
import { Client, Connection } from "@temporalio/client";

const log = getLogger({ component: "probe" });

const infra = loadInfraConfig();
const connection = await Connection.connect({ address: infra.temporal.address });
const client = new Client({ connection, namespace: infra.temporal.namespace });

const symbol = "BTCUSDT";
const source = "binance";

log.info("call 1 (expect spawn)");
await ensurePriceMonitorStarted(client, infra, { symbol, source });
log.info("call 1 ok");

log.info("call 2 (expect no-op, already running)");
await ensurePriceMonitorStarted(client, infra, { symbol, source });
log.info("call 2 ok");

log.info("call 3 (different symbol, expect new spawn)");
await ensurePriceMonitorStarted(client, infra, { symbol: "ETHUSDT", source });
log.info("call 3 ok");

await connection.close();
process.exit(0);
