import type { InfraConfig } from "@config/InfraConfig";
import type { Client } from "@temporalio/client";
import { priceMonitorWorkflowId } from "./priceMonitorWorkflow";

/**
 * Idempotent "start if not already running" for the shared per-symbol
 * price monitor. Both the dedicated activity and the inline call site in
 * `setupActivities.createSetup` use this so the workflow ID format and
 * the duplicate-start tolerance live in exactly one place.
 *
 * Spawns `price-monitor-${source}-${symbol}` on the scheduler task queue
 * when no instance with that ID is currently Running. Catches the
 * `WorkflowExecutionAlreadyStartedError` and returns silently.
 */
export async function ensurePriceMonitorStarted(
  client: Client,
  infra: InfraConfig,
  input: { symbol: string; source: string },
): Promise<void> {
  const workflowId = priceMonitorWorkflowId(input.symbol, input.source);
  try {
    await client.workflow.start("priceMonitorWorkflow", {
      args: [{ symbol: input.symbol, source: input.source }],
      workflowId,
      taskQueue: infra.temporal.task_queues.scheduler,
    });
  } catch (err) {
    if (/already.*started|alreadystarted/i.test((err as Error).message)) return;
    throw err;
  }
}
