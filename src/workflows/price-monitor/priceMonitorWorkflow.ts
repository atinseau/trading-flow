import { defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
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

export type PriceMonitorArgs = { symbol: string; source: string };

export const stopSignal = defineSignal<[]>("stop");

export async function priceMonitorWorkflow(args: PriceMonitorArgs): Promise<void> {
  let stop = false;
  setHandler(stopSignal, () => {
    stop = true;
  });

  while (!stop) {
    const aliveSetups = await dbActivities.listAliveSetupsForSymbol({
      symbol: args.symbol,
      source: args.source,
    });
    if (aliveSetups.length === 0) {
      // Last alive setup terminated — exit gracefully. We're spawned again
      // lazily when a new setup is created on this (symbol, source).
      return;
    }

    try {
      await longRunningActivities.subscribeAndCheckPriceFeed({
        symbol: args.symbol,
        source: args.source,
      });
      // The activity returned without throwing — that means the alive set
      // drained inside the activity. Re-check at the top of the loop; will exit.
    } catch (_err) {
      // Feed errored (network, etc). The proxy already retried up to limits.
      // Re-check the alive set at the top of the loop and decide.
      if (stop) return;
    }
  }
}

export const priceMonitorWorkflowId = (symbol: string, source: string): string =>
  `price-monitor-${source}-${symbol}`;
