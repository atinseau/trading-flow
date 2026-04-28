import type { Clock } from "@domain/ports/Clock";
import { parseTimeframeToMs } from "@domain/ports/Clock";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  candleDurationMs(timeframe: string): number {
    return parseTimeframeToMs(timeframe);
  }
}
