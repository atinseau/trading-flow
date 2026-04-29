import { useEffect } from "react";

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

/**
 * Schedules `refetch` to fire exactly when the next candle of `interval`
 * closes, then keeps firing on each subsequent close. Aligned to UTC wall
 * clock — a 1h timeframe fires at :00 of every hour, 1d fires at midnight UTC.
 *
 * Adds a 1s buffer after the close so the API has time to publish the new
 * candle before we fetch.
 */
export function useCandleAlignedRefetch(interval: string, refetch: () => void): void {
  useEffect(() => {
    const periodMs = INTERVAL_MS[interval];
    if (!periodMs) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = (): void => {
      const now = Date.now();
      const msUntilNext = periodMs - (now % periodMs);
      const buffer = 1000;
      timer = setTimeout(() => {
        refetch();
        scheduleNext();
      }, msUntilNext + buffer);
    };

    scheduleNext();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [interval, refetch]);
}
