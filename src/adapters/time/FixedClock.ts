import { type Clock, parseTimeframeToMs } from "@domain/ports/Clock";

/**
 * Clock locked to a specific instant. Used during replay to make the
 * domain's `clock.now()` return the playhead timestamp instead of the
 * real wall-clock time. Crucial for input-hash reproducibility: a given
 * tick at T must always produce the same prompt → same hash → cache hit.
 *
 * Immutable: there is no setter. A new FixedClock is created per tick.
 */
export class FixedClock implements Clock {
  constructor(private readonly fixedAt: Date) {}

  now(): Date {
    return new Date(this.fixedAt);
  }

  candleDurationMs(timeframe: string): number {
    return parseTimeframeToMs(timeframe);
  }
}
