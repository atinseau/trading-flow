import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import { priceMonitorWorkflowId } from "@workflows/price-monitor/priceMonitorWorkflow";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const log = getLogger({ component: "teardown-watch" });

const NOT_FOUND = /not found/i;

export async function tearDownWatch(input: { client: Client; watchId: string }): Promise<void> {
  const { client, watchId } = input;
  const watchLog = log.child({ watchId });

  const ignoreNotFound = (err: Error): void => {
    if (NOT_FOUND.test(err.message)) {
      watchLog.info({ msg: err.message }, "tear-down: target absent (idempotent)");
      return;
    }
    throw err;
  };

  await client.schedule.getHandle(`tick-${watchId}`).delete().catch(ignoreNotFound);

  await client.workflow
    .getHandle(schedulerWorkflowId(watchId))
    .terminate("watch deleted via UI")
    .catch(ignoreNotFound);

  await client.workflow
    .getHandle(priceMonitorWorkflowId(watchId))
    .terminate("watch deleted via UI")
    .catch(ignoreNotFound);

  watchLog.info("tear-down complete");
}
