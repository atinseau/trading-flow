import { expect, test } from "bun:test";
import {
  AssetNotFoundError,
  CircularFallbackError,
  ExchangeRateLimitError,
  FetchTimeoutError,
  InvalidConfigError,
  LLMRateLimitError,
  LLMSchemaValidationError,
  LLMTimeoutError,
  NoProviderAvailableError,
  PromptTooLargeError,
  StopRequestedError,
  TradingFlowError,
} from "@domain/errors";

test("retryable errors expose retryable=true", () => {
  expect(new LLMRateLimitError("x").retryable).toBe(true);
  expect(new LLMTimeoutError("x").retryable).toBe(true);
  expect(new FetchTimeoutError("x").retryable).toBe(true);
  expect(new ExchangeRateLimitError("x").retryable).toBe(true);
});

test("non-retryable errors expose retryable=false", () => {
  expect(new InvalidConfigError("x").retryable).toBe(false);
  expect(new AssetNotFoundError("x").retryable).toBe(false);
  expect(new LLMSchemaValidationError("x").retryable).toBe(false);
  expect(new PromptTooLargeError("x").retryable).toBe(false);
  expect(new NoProviderAvailableError("x").retryable).toBe(false);
  expect(new CircularFallbackError("x").retryable).toBe(false);
});

test("all errors are TradingFlowError instances with name property", () => {
  const e = new InvalidConfigError("test message");
  expect(e).toBeInstanceOf(TradingFlowError);
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe("InvalidConfigError");
  expect(e.message).toBe("test message");
});

test("StopRequestedError signals controlled stop, not retryable", () => {
  const e = new StopRequestedError("user requested");
  expect(e.retryable).toBe(false);
});
