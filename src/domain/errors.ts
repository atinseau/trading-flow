export abstract class TradingFlowError extends Error {
  abstract readonly retryable: boolean;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

// Retryable (transient)
export class LLMRateLimitError extends TradingFlowError {
  readonly retryable = true;
}
export class LLMTimeoutError extends TradingFlowError {
  readonly retryable = true;
}
export class FetchTimeoutError extends TradingFlowError {
  readonly retryable = true;
}
export class ExchangeRateLimitError extends TradingFlowError {
  readonly retryable = true;
}

// Non-retryable (config or business)
export class InvalidConfigError extends TradingFlowError {
  readonly retryable = false;
}
export class AssetNotFoundError extends TradingFlowError {
  readonly retryable = false;
}
export class LLMSchemaValidationError extends TradingFlowError {
  readonly retryable = false;
}
export class PromptTooLargeError extends TradingFlowError {
  readonly retryable = false;
}
export class NoProviderAvailableError extends TradingFlowError {
  readonly retryable = false;
}
export class CircularFallbackError extends TradingFlowError {
  readonly retryable = false;
}
export class StopRequestedError extends TradingFlowError {
  readonly retryable = false;
}
export class UnsupportedExchangeError extends TradingFlowError {
  readonly retryable = false;
  constructor(public readonly code: string | undefined) {
    super(`Exchange '${code ?? "<undefined>"}' not yet supported`);
  }
}

/**
 * Single source of truth for the names of unrecoverable domain errors,
 * used in two complementary ways across the codebase :
 *
 *   1. `proxyActivities({ retry: { nonRetryableErrorTypes: ... } })` —
 *      Temporal stops retrying when the activity throws one of these.
 *   2. Workflow main-loop `catch` handlers that mark the session FAILED
 *      vs. transiently PAUSED based on the error name.
 *
 * Keeping both lists derived from THIS constant prevents divergence
 * (workflow A removed a class but workflow B still listed it) and
 * keeps the catch logic in sync with the retry policy.
 */
export const UNRECOVERABLE_ERROR_NAMES = [
  "InvalidConfigError",
  "AssetNotFoundError",
  "LLMSchemaValidationError",
  "PromptTooLargeError",
  "NoProviderAvailableError",
  "CircularFallbackError",
  "StopRequestedError",
  "UnsupportedExchangeError",
] as const;

export type UnrecoverableErrorName = (typeof UNRECOVERABLE_ERROR_NAMES)[number];

/**
 * Returns `true` when `err.name` is one of the documented unrecoverable
 * domain errors. Used by workflow catch blocks to distinguish a config /
 * schema failure (move to FAILED) from a transient adapter outage
 * (move to PAUSED, let the user resume).
 *
 * Works through Temporal's `ApplicationFailure` wrapping : Temporal
 * preserves the original `error.name` as the failure's `.type`, which
 * surfaces as `err.name` on the workflow side.
 */
export function isUnrecoverableErrorName(name: string | undefined): boolean {
  if (!name) return false;
  return (UNRECOVERABLE_ERROR_NAMES as readonly string[]).includes(name);
}
