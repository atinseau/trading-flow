import { cronForTimeframe } from "@domain/services/cronForTimeframe";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const log = getLogger({ component: "apply-reload" });

export type ApplyReloadInput = {
  client: Client;
  watch: WatchConfig;
  previous: WatchConfig | null;
};

export async function applyReload(input: ApplyReloadInput): Promise<void> {
  const { client, watch, previous } = input;
  const watchLog = log.child({ watchId: watch.id });

  const newCron = watch.schedule.detector_cron ?? cronForTimeframe(watch.timeframes.primary);

  if (previous !== null) {
    const oldCron =
      previous.schedule.detector_cron ?? cronForTimeframe(previous.timeframes.primary);
    if (oldCron !== newCron) {
      const handle = client.schedule.getHandle(`tick-${watch.id}`);
      await handle.update((current) => ({
        ...current,
        spec: { cronExpressions: [newCron], timezone: watch.schedule.timezone ?? "UTC" },
      }));
      watchLog.info({ oldCron, newCron }, "updated schedule cron");
    }
  }

  await client.workflow.getHandle(schedulerWorkflowId(watch.id)).signal("reloadConfig", watch);
  watchLog.info("sent reloadConfig signal");
}
