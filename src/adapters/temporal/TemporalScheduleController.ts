import type { ScheduleController } from "@domain/ports/ScheduleController";
import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import { ScheduleNotFoundError } from "@temporalio/client";

const log = getLogger({ component: "temporal-schedule-controller" });

export class TemporalScheduleController implements ScheduleController {
  constructor(private client: Client) {}

  async pause(id: string, reason: string): Promise<void> {
    try {
      await this.client.schedule.getHandle(id).pause(reason);
    } catch (e) {
      if (isScheduleNotFound(e)) {
        log.warn({ id }, "pause skipped: schedule not found");
        return;
      }
      throw e;
    }
  }

  async unpause(id: string): Promise<void> {
    try {
      await this.client.schedule.getHandle(id).unpause();
    } catch (e) {
      if (isScheduleNotFound(e)) {
        log.warn({ id }, "unpause skipped: schedule not found");
        return;
      }
      throw e;
    }
  }
}

function isScheduleNotFound(e: unknown): boolean {
  if (e instanceof ScheduleNotFoundError) return true;
  // Defensive: some Temporal versions expose the error by name only.
  if (e instanceof Error && e.name === "ScheduleNotFoundError") return true;
  return false;
}
