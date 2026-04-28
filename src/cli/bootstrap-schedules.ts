import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
import { cronForTimeframe } from "@domain/services/cronForTimeframe";
import { getLogger } from "@observability/logger";
import { Client, Connection, ScheduleNotFoundError } from "@temporalio/client";
import { pickPriceFeedAdapter } from "@workflows/price-monitor/activities";
import { priceMonitorWorkflowId } from "@workflows/price-monitor/priceMonitorWorkflow";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const log = getLogger({ component: "bootstrap-schedules" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const infra = loadInfraConfig();
const watches = await loadWatchesConfig(configPath);

if (watches === null) {
  log.info({ configPath }, "standby: no watches.yaml — skipping schedule bootstrap");
  process.exit(0);
}

const connection = await Connection.connect({ address: infra.temporal.address });
const client = new Client({ connection, namespace: infra.temporal.namespace });

for (const watch of watches.watches.filter((w) => w.enabled)) {
  const watchLog = log.child({ watchId: watch.id });
  const cron = watch.schedule.detector_cron ?? cronForTimeframe(watch.timeframes.primary);
  watchLog.info(
    {
      timeframe: watch.timeframes.primary,
      cron,
      derived: !watch.schedule.detector_cron,
    },
    "schedule cron",
  );
  await client.workflow
    .start("schedulerWorkflow", {
      args: [
        {
          watchId: watch.id,
          analysisTaskQueue: infra.temporal.task_queues.analysis,
        },
      ],
      workflowId: schedulerWorkflowId(watch.id),
      taskQueue: infra.temporal.task_queues.scheduler,
    })
    .catch((err: Error) => {
      if (!/already running|already started|alreadystarted/i.test(err.message)) throw err;
    });

  await client.workflow
    .start("priceMonitorWorkflow", {
      args: [{ watchId: watch.id, adapter: pickPriceFeedAdapter(watch.asset.source) }],
      workflowId: priceMonitorWorkflowId(watch.id),
      taskQueue: infra.temporal.task_queues.scheduler,
    })
    .catch((err: Error) => {
      if (!/already running|already started|alreadystarted/i.test(err.message)) throw err;
    });

  const scheduleId = `tick-${watch.id}`;
  const handle = client.schedule.getHandle(scheduleId);
  try {
    await handle.describe();
    await handle.update((current) => ({
      ...current,
      spec: {
        cronExpressions: [cron],
        timezone: watch.schedule.timezone ?? "UTC",
      },
    }));
    watchLog.info("updated schedule");
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) {
      await client.schedule.create({
        scheduleId,
        spec: {
          cronExpressions: [cron],
          timezone: watch.schedule.timezone ?? "UTC",
        },
        action: {
          type: "startWorkflow",
          workflowType: "tickStarterWorkflow",
          workflowId: `tick-starter-${watch.id}`,
          taskQueue: infra.temporal.task_queues.scheduler,
          args: [{ watchId: watch.id }],
        },
      });
      watchLog.info("created schedule");
    } else throw err;
  }
}

log.info("done");
process.exit(0);
