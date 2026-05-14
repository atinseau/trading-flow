import type { Timeframe } from "@domain/replay/replaySessionRules";
import { timeframeToMs } from "./timeframeToMs";

export type ComputeTtlInput = {
  /** Base time (setup creation, or replay tick that created the setup). */
  fromTickAt: Date | string;
  ttlCandles: number;
  primaryTimeframe: Timeframe;
};

/**
 * Returns the absolute date at which a setup expires.
 *
 * Replaces the hardcoded `* 3_600_000` in `schedulerWorkflow.ts:189`
 * (assumed 1h candles regardless of timeframe — bug for non-1h watches).
 * Live and replay both call this so their TTL semantics stay in lockstep.
 */
export function computeTtlExpiresAt(input: ComputeTtlInput): Date {
  const baseMs =
    input.fromTickAt instanceof Date
      ? input.fromTickAt.getTime()
      : new Date(input.fromTickAt).getTime();
  return new Date(baseMs + input.ttlCandles * timeframeToMs(input.primaryTimeframe));
}
