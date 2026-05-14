/**
 * Timeframe → milliseconds. Single source of truth for the live + replay
 * pipelines so `ttlCandles * timeframe` math agrees across both.
 * Re-exports `timeframeToMinutes` from `src/domain/replay/replaySessionRules.ts`
 * to avoid duplicating the switch statement.
 */

import type { Timeframe } from "@domain/replay/replaySessionRules";
import { timeframeToMinutes } from "@domain/replay/replaySessionRules";

export { timeframeToMinutes } from "@domain/replay/replaySessionRules";

export function timeframeToMs(tf: Timeframe): number {
  return timeframeToMinutes(tf) * 60_000;
}
