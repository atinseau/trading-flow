import { defineSignal, proxyActivities, setHandler, sleep } from "@temporalio/workflow";
import type * as activities from "./activities";

const SHARED_NON_RETRYABLE = [
  "InvalidConfigError",
  "AssetNotFoundError",
  "LLMSchemaValidationError",
  "PromptTooLargeError",
  "NoProviderAvailableError",
  "CircularFallbackError",
  "StopRequestedError",
];

// DB / persistence activities — many fast retries (transient DB blips).
const dbActivities = proxyActivities<ReturnType<typeof activities.buildPriceMonitorActivities>>({
  startToCloseTimeout: "10s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "100ms",
    maximumInterval: "5s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

// Long-running price feed activity — heartbeat-driven, many retries to survive network blips.
const longRunningActivities = proxyActivities<
  ReturnType<typeof activities.buildPriceMonitorActivities>
>({
  startToCloseTimeout: "10m",
  heartbeatTimeout: "60s",
  retry: {
    maximumAttempts: 100,
    initialInterval: "5s",
    maximumInterval: "1m",
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

export type PriceMonitorArgs = {
  watchId: string;
  adapter: string;
};

export const stopSignal = defineSignal<[]>("stop");

export async function priceMonitorWorkflow(args: PriceMonitorArgs): Promise<void> {
  let stop = false;
  setHandler(stopSignal, () => {
    stop = true;
  });

  while (!stop) {
    const aliveSetups = await dbActivities.listAliveSetupsWithInvalidation({
      watchId: args.watchId,
    });
    if (aliveSetups.length === 0) {
      await sleep(60_000);
      continue;
    }

    try {
      await longRunningActivities.subscribeAndCheckPriceFeed({
        watchId: args.watchId,
        adapter: args.adapter,
        assets: [...new Set(aliveSetups.map((s) => s.asset))],
      });
    } catch {
      await sleep(5_000);
    }
  }
}

export const priceMonitorWorkflowId = (watchId: string) => `price-monitor-${watchId}`;
