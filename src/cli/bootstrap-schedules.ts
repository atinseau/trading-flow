import { loadConfig } from "@config/loadConfig";
import { Client, Connection, ScheduleNotFoundError } from "@temporalio/client";
import { pickPriceFeedAdapter } from "@workflows/price-monitor/activities";
import { priceMonitorWorkflowId } from "@workflows/price-monitor/priceMonitorWorkflow";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const configPath = process.argv[2] ?? "config/watches.yaml";
const config = await loadConfig(configPath);
const connection = await Connection.connect({ address: config.temporal.address });
const client = new Client({ connection, namespace: config.temporal.namespace });

for (const watch of config.watches.filter((w) => w.enabled)) {
  // Start SchedulerWorkflow (idempotent via workflowId)
  await client.workflow
    .start("schedulerWorkflow", {
      args: [
        {
          watchId: watch.id,
          analysisTaskQueue: config.temporal.task_queues.analysis,
        },
      ],
      workflowId: schedulerWorkflowId(watch.id),
      taskQueue: config.temporal.task_queues.scheduler,
    })
    .catch((err: Error) => {
      if (!/already running|already started|alreadystarted/i.test(err.message)) throw err;
    });

  // Start PriceMonitorWorkflow
  await client.workflow
    .start("priceMonitorWorkflow", {
      args: [{ watchId: watch.id, adapter: pickPriceFeedAdapter(watch.asset.source) }],
      workflowId: priceMonitorWorkflowId(watch.id),
      taskQueue: config.temporal.task_queues.scheduler,
    })
    .catch((err: Error) => {
      if (!/already running|already started|alreadystarted/i.test(err.message)) throw err;
    });

  // Create or update Schedule that signals doTick (via tickStarterWorkflow,
  // since Temporal Schedules only support startWorkflow as their action).
  const scheduleId = `tick-${watch.id}`;
  const handle = client.schedule.getHandle(scheduleId);
  try {
    await handle.describe();
    await handle.update((current) => ({
      ...current,
      spec: {
        cronExpressions: [watch.schedule.detector_cron],
        timezone: watch.schedule.timezone ?? "UTC",
      },
    }));
    console.log(`[bootstrap] updated schedule for ${watch.id}`);
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) {
      await client.schedule.create({
        scheduleId,
        spec: {
          cronExpressions: [watch.schedule.detector_cron],
          timezone: watch.schedule.timezone ?? "UTC",
        },
        action: {
          type: "startWorkflow",
          workflowType: "tickStarterWorkflow",
          workflowId: `tick-starter-${watch.id}`,
          taskQueue: config.temporal.task_queues.scheduler,
          args: [{ watchId: watch.id }],
        },
      });
      console.log(`[bootstrap] created schedule for ${watch.id}`);
    } else throw err;
  }
}

console.log("[bootstrap] done");
process.exit(0);
