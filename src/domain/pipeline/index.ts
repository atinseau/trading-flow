/**
 * Pipeline-helper barrel.
 *
 * Single import surface for the pure decision/computation helpers shared
 * by live (`src/workflows/setup/`, `src/workflows/scheduler/`) and replay
 * (`src/workflows/replay/`). The hexagonal-architecture rule still
 * applies — these helpers live in `src/domain/` and have no I/O, no
 * Temporal imports, no adapters.
 *
 * Both `@domain/*` aliases and sibling-relative paths are valid for
 * import here ; `replaySessionWorkflow.ts`, `schedulerWorkflow.ts`, and
 * `processTick.ts` use the alias for value imports without issue. The
 * `setupWorkflow.ts` / `trackingLoop.ts` files happen to use relative
 * paths everywhere — that's a per-file convention, not a constraint.
 */

export type {
  CorroborationInput,
  CorroborationResult,
  ScoringConfig,
  SetupRuntimeState,
} from "./applyCorroboration";
export { applyCorroboration } from "./applyCorroboration";
export type { PriceCheckInput, PriceCheckResult } from "./applyPriceCheck";
export { applyPriceCheck } from "./applyPriceCheck";
export type { ComputeTtlInput } from "./computeTtlExpiresAt";
export { computeTtlExpiresAt } from "./computeTtlExpiresAt";
export type {
  PriceInvalidationEvent,
  PriceInvalidationEventInput,
} from "./priceInvalidationEvent";
export { buildPriceInvalidationEvent } from "./priceInvalidationEvent";
export type { ShouldRunFeedbackInput } from "./shouldRunFeedback";
export { shouldRunFeedback } from "./shouldRunFeedback";

export { timeframeToMinutes, timeframeToMs } from "./timeframeToMs";
