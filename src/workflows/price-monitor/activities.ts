import { InvalidConfigError, StopRequestedError } from "@domain/errors";
import { Context } from "@temporalio/activity";
import type { ActivityDeps } from "@workflows/activityDependencies";

const ADAPTER_BY_SOURCE: Record<string, string> = {
  binance: "binance_ws",
  yahoo: "yahoo_polling",
};

export function pickPriceFeedAdapter(assetSource: string): string {
  const a = ADAPTER_BY_SOURCE[assetSource];
  if (!a) throw new InvalidConfigError(`No price feed strategy for source ${assetSource}`);
  return a;
}

export function buildPriceMonitorActivities(deps: ActivityDeps) {
  return {
    async listAliveSetupsWithInvalidation(input: { watchId: string }) {
      return deps.setupRepo.listAliveWithInvalidation(input.watchId);
    },

    async subscribeAndCheckPriceFeed(input: {
      watchId: string;
      adapter: string;
      assets: string[];
    }): Promise<void> {
      const feed = deps.priceFeeds.get(input.adapter);
      if (!feed) throw new InvalidConfigError(`Unknown price feed adapter: ${input.adapter}`);

      const stream = feed.subscribe({ watchId: input.watchId, assets: input.assets });
      let lastRefresh = Date.now();
      let cachedSetups = await deps.setupRepo.listAliveWithInvalidation(input.watchId);

      for await (const tick of stream) {
        Context.current().heartbeat({ lastTickAt: tick.timestamp.toISOString() });

        if (Date.now() - lastRefresh > 60_000) {
          cachedSetups = await deps.setupRepo.listAliveWithInvalidation(input.watchId);
          lastRefresh = Date.now();
        }

        for (const setup of cachedSetups) {
          if (setup.asset !== tick.asset || setup.invalidationLevel == null) continue;
          const breached =
            (setup.direction === "LONG" && tick.price < setup.invalidationLevel) ||
            (setup.direction === "SHORT" && tick.price > setup.invalidationLevel);
          if (breached) {
            console.log("[price invalidated]", setup.id, tick.price);
          }
        }
      }
      throw new StopRequestedError("price feed ended");
    },
  };
}
