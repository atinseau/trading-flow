/**
 * Abstraction over Temporal Schedule pause/unpause. Used by the market-clock
 * workflow to gate per-watch ticks at market session boundaries.
 *
 * Implementations MUST be idempotent: pausing an already-paused schedule or
 * unpausing an already-running one is a no-op (or at least non-throwing).
 * Implementations MUST NOT throw on "schedule not found" — log and return.
 */
export interface ScheduleController {
  pause(scheduleId: string, reason: string): Promise<void>;
  unpause(scheduleId: string): Promise<void>;
}
