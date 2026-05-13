import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { FeedbackMode, LessonsMode } from "./ReplaySession";

/** Maximum number of candles a single replay session can span. */
export const MAX_WINDOW_CANDLES = 300;

/** Minimum cost cap to allow any session to make progress. */
export const MIN_COST_CAP_USD = 0.5;

/** Default cost cap when not specified by the caller. */
export const DEFAULT_COST_CAP_USD = 5;

export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "1w";

export type CreateSessionArgs = {
  watchId: string;
  watchConfig: WatchConfig;
  name?: string;
  windowStartAt: Date;
  windowEndAt: Date;
  lessonsMode: LessonsMode;
  feedbackMode: FeedbackMode;
  costCapUsd: number;
  /** Injected for testability (replaces `new Date()`). */
  now: Date;
};

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * Pure validation of a `POST /api/replay/sessions` request. Refuses
 * inverted windows, windows that touch the present/future (spec §14),
 * windows that span more than `MAX_WINDOW_CANDLES` candles (spec §10
 * invariant 8), and cost caps too low to be useful.
 */
export function validateCreateSession(args: CreateSessionArgs): ValidationResult {
  if (args.windowEndAt <= args.windowStartAt) {
    return { ok: false, reason: "window_invalid" };
  }
  if (args.windowEndAt >= args.now) {
    return { ok: false, reason: "window_includes_future" };
  }
  if (args.costCapUsd < MIN_COST_CAP_USD) {
    return { ok: false, reason: "cost_cap_too_low" };
  }
  const tf = args.watchConfig.timeframes.primary as Timeframe;
  const minutesPerCandle = timeframeToMinutes(tf);
  const windowMinutes = (args.windowEndAt.getTime() - args.windowStartAt.getTime()) / 60_000;
  const candleCount = Math.ceil(windowMinutes / minutesPerCandle);
  if (candleCount > MAX_WINDOW_CANDLES) {
    return { ok: false, reason: "window_too_large" };
  }
  return { ok: true };
}

/**
 * Returns the deterministic Temporal workflow ID for a replay session.
 * Stable across restarts and across multiple `signalWithStart` calls
 * — guarantees idempotence when starting/signaling the workflow.
 */
export function buildWorkflowId(sessionId: string): string {
  return `replay-session-${sessionId}`;
}

/** Minutes per candle for each supported timeframe. */
export function timeframeToMinutes(tf: Timeframe): number {
  switch (tf) {
    case "1m":
      return 1;
    case "5m":
      return 5;
    case "15m":
      return 15;
    case "30m":
      return 30;
    case "1h":
      return 60;
    case "2h":
      return 120;
    case "4h":
      return 240;
    case "1d":
      return 1440;
    case "1w":
      return 10080;
  }
}
