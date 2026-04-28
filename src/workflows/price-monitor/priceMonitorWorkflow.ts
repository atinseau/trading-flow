import { defineSignal, proxyActivities, setHandler, sleep } from "@temporalio/workflow";
import type * as activities from "./activities";

const a = proxyActivities<ReturnType<typeof activities.buildPriceMonitorActivities>>({
  startToCloseTimeout: "10m",
  heartbeatTimeout: "60s",
  retry: { maximumAttempts: 100, initialInterval: "5s", maximumInterval: "1m" },
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
    const aliveSetups = await a.listAliveSetupsWithInvalidation({ watchId: args.watchId });
    if (aliveSetups.length === 0) {
      await sleep(60_000);
      continue;
    }

    try {
      await a.subscribeAndCheckPriceFeed({
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
