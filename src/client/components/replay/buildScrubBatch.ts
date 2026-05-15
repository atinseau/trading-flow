/**
 * Pure helpers used by the active scrubber : compute the tick batch and a
 * cost estimate when the user releases the scrubber forward of the bot.
 *
 * Why a separate file. The scrubber's commit handler in `replay-session.tsx`
 * is otherwise a busy mix of state setters + dialog open/close + step
 * dispatch ; doing the math here keeps the truth-table testable without
 * spinning up React / Query / Router.
 *
 * Batch cap : the `replayTick` Temporal signal accepts up to 50 tickAts
 * in a single payload (see `src/workflows/replay/replaySessionWorkflow.ts`
 * docblock). We cap here so the UI never builds an array the worker would
 * have to reject — when truncated, the dialog tells the user.
 */

export const MAX_BATCH_TICKS = 50;

export type ScrubBatchInput = {
  /** Where the bot is currently — `lastTickAt` from workflow OR window start. */
  botAtMs: number;
  /** Where the user dragged the scrubber to. */
  targetAtMs: number;
  /** Primary timeframe in ms (`timeframeToMinutes(tf) * 60_000`). */
  timeframeMs: number;
  /**
   * Optional upper bound — the session's `windowEndAt`. The workflow's
   * replayTick handler silently drops tickAts outside the window, so we
   * clamp here too : the modal must not promise "50 ticks" when half
   * would be dropped server-side. When unset, no upper bound is applied
   * (kept optional for backward compat with the existing tests).
   */
  windowEndMs?: number;
};

export type ScrubBatch = {
  /** ISO tickAts to send in a single replayTick signal. */
  tickAts: string[];
  /** Last tickAt of the batch (== effective target after cap). */
  effectiveTargetAt: Date;
  /** True iff the requested distance exceeded MAX_BATCH_TICKS. */
  truncatedToMax: boolean;
  /** Number of ticks in the batch (0 means "no forward dispatch needed"). */
  tickCount: number;
};

/**
 * Build the sequence of tickAts between `botAtMs` (exclusive) and
 * `targetAtMs` (inclusive when on-grid, snapped down to the previous
 * grid otherwise). Returns an empty batch when target ≤ bot — drag
 * backward is a pure view, no LLM cost.
 */
export function buildScrubBatch(input: ScrubBatchInput): ScrubBatch {
  if (input.timeframeMs <= 0 || !Number.isFinite(input.timeframeMs)) {
    return emptyBatch(input.botAtMs);
  }
  // Clamp the target at the session's windowEnd if provided — the workflow
  // would drop overshoot ticks server-side anyway.
  const ceiling =
    input.windowEndMs !== undefined && Number.isFinite(input.windowEndMs)
      ? Math.min(input.targetAtMs, input.windowEndMs)
      : input.targetAtMs;
  const deltaMs = ceiling - input.botAtMs;
  if (deltaMs < input.timeframeMs) {
    // Less than one full tick forward — nothing to dispatch.
    return emptyBatch(input.botAtMs);
  }
  const fullTicks = Math.floor(deltaMs / input.timeframeMs);
  const capped = Math.min(fullTicks, MAX_BATCH_TICKS);
  const tickAts: string[] = [];
  for (let i = 1; i <= capped; i++) {
    tickAts.push(new Date(input.botAtMs + i * input.timeframeMs).toISOString());
  }
  const effectiveTargetAt = new Date(input.botAtMs + capped * input.timeframeMs);
  return {
    tickAts,
    effectiveTargetAt,
    truncatedToMax: fullTicks > MAX_BATCH_TICKS,
    tickCount: capped,
  };
}

function emptyBatch(botAtMs: number): ScrubBatch {
  return {
    tickAts: [],
    effectiveTargetAt: new Date(botAtMs),
    truncatedToMax: false,
    tickCount: 0,
  };
}

export type CostEstimateInput = {
  /** Cost in USD spent by the session so far. */
  costUsdSoFar: number;
  /** Number of *processed* detector ticks (used as denominator). */
  ticksProcessed: number;
  /** Number of currently alive setups (each consumes a reviewer call per tick). */
  aliveSetupsCount: number;
  /** Detector calls' running average cost per call ; null if no data. */
  detectorAvgUsdPerCall: number | null;
  /** Reviewer calls' running average cost per call ; null if no data. */
  reviewerAvgUsdPerCall: number | null;
  /** How many ticks we're about to dispatch. */
  tickCount: number;
};

/**
 * Best-effort cost estimate for a forward scrub. Strategy :
 *
 *  1. Prefer per-stage averages from the session's own LLM calls
 *     (`detectorAvgUsdPerCall` + `reviewerAvgUsdPerCall × aliveSetups`).
 *  2. Fall back to (costSoFar / ticksProcessed) × tickCount when the
 *     per-stage breakdown isn't available yet.
 *  3. Fall back to a generic $0.50/tick rough order of magnitude when
 *     the session has no history at all (first scrub on a fresh session).
 *
 * Returns USD as a number — the dialog formats with `.toFixed(2)`.
 */
export function estimateScrubCost(input: CostEstimateInput): number {
  if (input.tickCount <= 0) return 0;
  if (input.detectorAvgUsdPerCall !== null && input.reviewerAvgUsdPerCall !== null) {
    const perTick =
      input.detectorAvgUsdPerCall + input.reviewerAvgUsdPerCall * input.aliveSetupsCount;
    return perTick * input.tickCount;
  }
  if (input.ticksProcessed > 0 && input.costUsdSoFar > 0) {
    const perTickHistorical = input.costUsdSoFar / input.ticksProcessed;
    return perTickHistorical * input.tickCount;
  }
  // Fresh session — no data to extrapolate from. Lowball rough estimate.
  return 0.5 * input.tickCount;
}
