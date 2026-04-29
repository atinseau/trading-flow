import type { Clock } from "@domain/ports/Clock";
import type { ScheduleController } from "@domain/ports/ScheduleController";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { cronForTimeframe } from "@domain/services/cronForTimeframe";
import { getSession, getSessionState } from "@domain/services/marketSession";
import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import { ScheduleNotFoundError } from "@temporalio/client";
import { ensureMarketClock } from "@workflows/marketClock/ensureMarketClock";
import { pickPriceFeedAdapter } from "@workflows/price-monitor/activities";
import { priceMonitorWorkflowId } from "@workflows/price-monitor/priceMonitorWorkflow";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

export type TaskQueues = {
  scheduler: string;
  analysis: string;
  notifications: string;
};

export type BootstrapDeps = {
  client: Client;
  taskQueues: TaskQueues;
  scheduleController: ScheduleController;
  clock: Clock;
};

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

  await client.workflow
    .start("priceMonitorWorkflow", {
      args: [{ watchId: watch.id, adapter: pickPriceFeedAdapter(watch.asset.source) }],
      workflowId: priceMonitorWorkflowId(watch.id),
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

  // Market-hours awareness: ensure a clock workflow exists for this watch's
  // session, and pause the schedule immediately if the market is currently closed.
  let session: ReturnType<typeof getSession>;
  try {
    session = getSession(watch);
  } catch (err) {
    // Invalid asset metadata (e.g. unknown exchange). Surface but don't block;
    // the watch's tick schedule was already created and will run normally —
    // the market-hours feature simply doesn't apply to this asset.
    watchLog.warn(
      { err: (err as Error).message },
      "bootstrapWatch: skipping market-clock setup (invalid asset metadata)",
    );
    return;
  }
  if (session.kind !== "always-open") {
    await ensureMarketClock({
      client,
      taskQueue: taskQueues.scheduler,
      session,
    });
    const state = getSessionState(session, deps.clock.now());
    if (!state.isOpen) {
      await deps.scheduleController.pause(scheduleId, "market closed at watch creation");
      watchLog.info({ scheduleId }, "paused schedule because market is closed at creation");
    }
  }
}
