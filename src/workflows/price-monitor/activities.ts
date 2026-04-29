import { InvalidConfigError, StopRequestedError } from "@domain/errors";
import { getSession, getSessionState } from "@domain/services/marketSession";
import { getLogger } from "@observability/logger";
import { Context } from "@temporalio/activity";
import type { ActivityDeps } from "@workflows/activityDependencies";

const log = getLogger({ component: "price-monitor-activities" });

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
      const childLog = log.child({ watchId: input.watchId, adapter: input.adapter });
      const feed = deps.priceFeeds.get(input.adapter);
      if (!feed) throw new InvalidConfigError(`Unknown price feed adapter: ${input.adapter}`);

      const watch = deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      const session = getSession(watch);

      childLog.info({ assetCount: input.assets.length }, "subscribing to price feed");
      const stream = feed.subscribe({ watchId: input.watchId, assets: input.assets });
      let lastRefresh = Date.now();
      let cachedSetups = await deps.setupRepo.listAliveWithInvalidation(input.watchId);

      for await (const tick of stream) {
        Context.current().heartbeat({ lastTickAt: tick.timestamp.toISOString() });

        // Skip signal emission if the market is closed (avoids waking setups
        // during overnight/weekend/holiday). Activity stays alive — next tick
        // after reopen will resume normal emission.
        if (!getSessionState(session, deps.clock.now()).isOpen) {
          continue;
        }

        if (Date.now() - lastRefresh > 60_000) {
          cachedSetups = await deps.setupRepo.listAliveWithInvalidation(input.watchId);
          lastRefresh = Date.now();
        }

        for (const setup of cachedSetups) {
          if (setup.asset !== tick.asset) continue;

          // TRACKING phase: forward every tick to the trackingLoop's signal so
          // it can detect TP/SL hits. Level comparison happens inside the loop.
          if (setup.status === "TRACKING") {
            await deps.temporalClient.workflow
              .getHandle(setup.workflowId)
              .signal("trackingPrice", {
                currentPrice: tick.price,
                observedAt: tick.timestamp.toISOString(),
              })
              .catch((err: Error) =>
                childLog.warn(
                  { workflowId: setup.workflowId, err: err.message },
                  "trackingPrice signal failed (workflow may be closed)",
                ),
              );
            continue;
          }

          // REVIEWING/FINALIZING: only signal on invalidation breach.
          if (setup.invalidationLevel == null) continue;
          const breached =
            (setup.direction === "LONG" && tick.price < setup.invalidationLevel) ||
            (setup.direction === "SHORT" && tick.price > setup.invalidationLevel);
          if (breached) {
            await deps.temporalClient.workflow
              .getHandle(setup.workflowId)
              .signal("priceCheck", {
                currentPrice: tick.price,
                observedAt: tick.timestamp.toISOString(),
              })
              .catch((err: Error) =>
                childLog.warn(
                  { workflowId: setup.workflowId, err: err.message },
                  "priceCheck signal failed (workflow may be closed)",
                ),
              );
          }
        }
      }
      throw new StopRequestedError("price feed ended");
    },
  };
}
