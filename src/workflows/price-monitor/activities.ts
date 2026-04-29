import { InvalidConfigError, StopRequestedError } from "@domain/errors";
import { getLogger } from "@observability/logger";
import { Context } from "@temporalio/activity";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { ensurePriceMonitorStarted } from "./ensureRunning";
import { priceMonitorWorkflowId } from "./priceMonitorWorkflow";

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
    async listAliveSetupsForSymbol(input: { symbol: string; source: string }) {
      return deps.setupRepo.listAliveBySymbol(input.symbol, input.source);
    },

    async ensurePriceMonitorRunning(input: { symbol: string; source: string }): Promise<void> {
      await ensurePriceMonitorStarted(deps.temporalClient, deps.infra, input);
    },

    async subscribeAndCheckPriceFeed(input: { symbol: string; source: string }): Promise<void> {
      const adapter = pickPriceFeedAdapter(input.source);
      const childLog = log.child({ symbol: input.symbol, source: input.source, adapter });
      const feed = deps.priceFeeds.get(adapter);
      if (!feed) throw new InvalidConfigError(`Unknown price feed adapter: ${adapter}`);

      childLog.info("subscribing to price feed");
      // PriceFeed.subscribe takes { watchId, assets } today; watchId is used as
      // a logging tag inside the adapter, not for routing. Pass the workflow
      // id for traceability.
      const stream = feed.subscribe({
        watchId: priceMonitorWorkflowId(input.symbol, input.source),
        assets: [input.symbol],
      });
      let lastRefresh = Date.now();
      let cachedSetups = await deps.setupRepo.listAliveBySymbol(input.symbol, input.source);

      for await (const tick of stream) {
        Context.current().heartbeat({ lastTickAt: tick.timestamp.toISOString() });

        if (Date.now() - lastRefresh > 60_000) {
          cachedSetups = await deps.setupRepo.listAliveBySymbol(input.symbol, input.source);
          lastRefresh = Date.now();
          if (cachedSetups.length === 0) {
            childLog.info("no alive setups remaining — exiting");
            return;
          }
        }

        for (const setup of cachedSetups) {
          if (setup.asset !== tick.asset) continue;

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
