import { expect, test } from "bun:test";
import { computeInputHash } from "@domain/services/inputHash";

test("same inputs produce same hash", () => {
  const a = computeInputHash({
    setupId: "s1",
    promptVersion: "v1",
    ohlcvSnapshot: "abc",
    chartUri: "x",
    indicators: { rsi: 50 },
  });
  const b = computeInputHash({
    setupId: "s1",
    promptVersion: "v1",
    ohlcvSnapshot: "abc",
    chartUri: "x",
    indicators: { rsi: 50 },
  });
  expect(a).toBe(b);
});

test("different setupId produces different hash", () => {
  const a = computeInputHash({
    setupId: "s1",
    promptVersion: "v1",
    ohlcvSnapshot: "abc",
    chartUri: "x",
    indicators: { rsi: 50 },
  });
  const b = computeInputHash({
    setupId: "s2",
    promptVersion: "v1",
    ohlcvSnapshot: "abc",
    chartUri: "x",
    indicators: { rsi: 50 },
  });
  expect(a).not.toBe(b);
});

test("hash is deterministic regardless of indicator key order", () => {
  const a = computeInputHash({
    setupId: "s1",
    promptVersion: "v1",
    ohlcvSnapshot: "abc",
    chartUri: "x",
    indicators: { rsi: 50, ema: 100 },
  });
  const b = computeInputHash({
    setupId: "s1",
    promptVersion: "v1",
    ohlcvSnapshot: "abc",
    chartUri: "x",
    indicators: { ema: 100, rsi: 50 },
  });
  expect(a).toBe(b);
});

test("hash is 64 hex chars (sha256)", () => {
  const h = computeInputHash({
    setupId: "s1",
    promptVersion: "v1",
    ohlcvSnapshot: "abc",
    chartUri: "x",
    indicators: {},
  });
  expect(h).toMatch(/^[a-f0-9]{64}$/);
});
