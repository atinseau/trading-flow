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
export class DBConnectionError extends TradingFlowError {
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
