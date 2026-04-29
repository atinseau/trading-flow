import { cronForTimeframe } from "@domain/services/cronForTimeframe";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import { ScheduleNotFoundError } from "@temporalio/client";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

export type TaskQueues = {
  scheduler: string;
  analysis: string;
  notifications: string;
};

export type BootstrapDeps = { client: Client; taskQueues: TaskQueues };

const log = getLogger({ component: "bootstrap-watch" });

const ALREADY_RUNNING = /already running|already started|alreadystarted/i;

export async function bootstrapWatch(watch: WatchConfig, deps: BootstrapDeps): Promise<void> {
  const { client, taskQueues } = deps;
  const watchLog = log.child({ watchId: watch.id });
  const cron = watch.schedule.detector_cron ?? cronForTimeframe(watch.timeframes.primary);

  await client.workflow
    .start("schedulerWorkflow", {
      args: [{ watchId: watch.id, analysisTaskQueue: taskQueues.analysis }],
      workflowId: schedulerWorkflowId(watch.id),
      taskQueue: taskQueues.scheduler,
    })
    .catch((err: Error) => {
      if (!ALREADY_RUNNING.test(err.message)) throw err;
    });

  const scheduleId = `tick-${watch.id}`;
  const handle = client.schedule.getHandle(scheduleId);
  try {
    await handle.describe();
    await handle.update((current) => ({
      ...current,
      spec: { cronExpressions: [cron], timezone: watch.schedule.timezone ?? "UTC" },
    }));
    watchLog.info({ cron }, "updated schedule");
  } catch (err) {
    if (err instanceof ScheduleNotFoundError || (err as Error).name === "ScheduleNotFoundError") {
      await client.schedule.create({
        scheduleId,
        spec: { cronExpressions: [cron], timezone: watch.schedule.timezone ?? "UTC" },
        action: {
          type: "startWorkflow",
          workflowType: "tickStarterWorkflow",
          workflowId: `tick-starter-${watch.id}`,
          taskQueue: taskQueues.scheduler,
          args: [{ watchId: watch.id }],
        },
      });
      watchLog.info({ cron }, "created schedule");
    } else throw err;
  }
}
