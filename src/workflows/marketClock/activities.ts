import { type Session, watchesInSession } from "@domain/services/marketSession";
import { getLogger } from "@observability/logger";
import type { ActivityDeps } from "@workflows/activityDependencies";

const log = getLogger({ component: "market-clock-activities" });

export function buildMarketClockActivities(deps: ActivityDeps) {
  return {
    async getNow(): Promise<Date> {
      return deps.clock.now();
    },

    async listWatchesInSession(session: Session): Promise<{ id: string }[]> {
      const all = await deps.watchRepo.findEnabled();
      return watchesInSession(all, session).map((w) => ({ id: w.id }));
    },

    async applyToSchedules(input: {
      ids: string[];
      action: "pause" | "unpause";
      reason: string;
    }): Promise<void> {
      const { ids, action, reason } = input;
      log.info({ count: ids.length, action }, "applying schedule action");
      for (const id of ids) {
        if (action === "pause") {
          await deps.scheduleController.pause(id, reason);
        } else {
          await deps.scheduleController.unpause(id);
        }
      }
    },
  };
}

export type MarketClockActivities = ReturnType<typeof buildMarketClockActivities>;
