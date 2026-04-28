import type { Clock } from "@domain/ports/Clock";
import { parseTimeframeToMs } from "@domain/ports/Clock";

export class FakeClock implements Clock {
  constructor(private currentTime: Date = new Date("2026-04-28T14:00:00Z")) {}

  now(): Date {
    return new Date(this.currentTime);
  }

  candleDurationMs(timeframe: string): number {
    return parseTimeframeToMs(timeframe);
  }

  set(time: Date): void {
    this.currentTime = time;
  }

  advance(ms: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + ms);
  }

  advanceTimeframe(timeframe: string, n = 1): void {
    this.advance(parseTimeframeToMs(timeframe) * n);
  }
}
