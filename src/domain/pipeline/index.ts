/**
 * Pipeline-helper barrel.
 *
 * Single import surface for the pure decision/computation helpers shared
 * by live (`src/workflows/setup/`, `src/workflows/scheduler/`) and replay
 * (`src/workflows/replay/`). The hexagonal-architecture rule still
 * applies — these helpers live in `src/domain/` and have no I/O, no
 * Temporal imports, no adapters.
 *
 * Note for workflow consumers : `setupWorkflow.ts` and other files
 * bundled into Temporal's V8 sandbox MUST import value symbols via
 * relative paths (e.g. `../../domain/pipeline/applyCorroboration`)
 * because webpack does not honor the `@domain/*` tsconfig alias for
 * runtime imports. Type-only imports (`import type ...`) via the alias
 * are erased and therefore safe.
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
