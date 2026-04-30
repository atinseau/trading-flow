import type { InfraConfig } from "@config/InfraConfig";
import type { Client } from "@temporalio/client";
import { priceMonitorWorkflowId } from "./priceMonitorWorkflow";

/**
 * Idempotent "start if not already running" for the shared per-symbol
 * price monitor. Both the dedicated activity and the inline call site in
 * `setupActivities.createSetup` use this so the workflow ID format and
 * the spawn-or-noop semantic live in exactly one place.
 *
 * Uses Temporal's native `signalWithStart`: if no workflow with this ID
 * is currently Running, the SDK starts one and dispatches the signal.
 * If one is already Running, the signal is delivered without re-starting.
 * Either way no exception is thrown, so no error-message matching needed.
 *
 * The signal itself is `ensureRunningSignal`, a no-op declared on the
 * workflow purely to satisfy `signalWithStart`'s contract — see the
 * comment in `priceMonitorWorkflow.ts`.
 */
export async function ensurePriceMonitorStarted(
  client: Client,
  infra: InfraConfig,
  input: { symbol: string; source: string },
): Promise<void> {
  await client.workflow.signalWithStart("priceMonitorWorkflow", {
    workflowId: priceMonitorWorkflowId(input.symbol, input.source),
    taskQueue: infra.temporal.task_queues.scheduler,
    args: [{ symbol: input.symbol, source: input.source }],
    signal: "ensureRunning",
    signalArgs: [],
  });
}
