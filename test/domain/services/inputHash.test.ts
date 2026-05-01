import { expect, test, describe } from "bun:test";
import { computeInputHash } from "@domain/services/inputHash";

const BASE = {
  setupId: "s1",
  promptVersion: "v1",
  ohlcvSnapshot: "abc",
  chartUri: "x",
  indicators: { rsi: 50 },
};

test("same inputs produce same hash", () => {
  const a = computeInputHash(BASE);
  const b = computeInputHash(BASE);
  expect(a).toBe(b);
});

test("different setupId produces different hash", () => {
  const a = computeInputHash(BASE);
  const b = computeInputHash({ ...BASE, setupId: "s2" });
  expect(a).not.toBe(b);
});

test("hash is deterministic regardless of indicator key order", () => {
  const a = computeInputHash({ ...BASE, indicators: { rsi: 50, ema: 100 } });
  const b = computeInputHash({ ...BASE, indicators: { ema: 100, rsi: 50 } });
  expect(a).toBe(b);
});

test("hash is 64 hex chars (sha256)", () => {
  const h = computeInputHash({ ...BASE, indicators: {} });
  expect(h).toMatch(/^[a-f0-9]{64}$/);
});

describe("inputHash params sensitivity", () => {
  test("two watches differ only in rsi.period → different inputHash", () => {
    const a = computeInputHash({
      ...BASE,
      indicatorParams: { rsi: { period: 14 } },
    });
    const b = computeInputHash({
      ...BASE,
      indicatorParams: { rsi: { period: 21 } },
    });
    expect(a).not.toBe(b);
  });

  test("explicit default params produce same hash as no params", () => {
    // period: 14 is the RSI default — should be normalized away
    const withDefault = computeInputHash({
      ...BASE,
      indicatorParams: { rsi: { period: 14 } },
    });
    const withoutParams = computeInputHash(BASE);
    expect(withDefault).toBe(withoutParams);
  });

  test("undefined indicatorParams same as empty object", () => {
    const withUndefined = computeInputHash(BASE);
    const withEmpty = computeInputHash({ ...BASE, indicatorParams: {} });
    expect(withUndefined).toBe(withEmpty);
  });

  test("non-default params produce different hash than no params", () => {
    const withCustom = computeInputHash({
      ...BASE,
      indicatorParams: { rsi: { period: 21 } },
    });
    const withoutParams = computeInputHash(BASE);
    expect(withCustom).not.toBe(withoutParams);
  });

  test("indicatorParams key order does not affect hash", () => {
    const a = computeInputHash({
      ...BASE,
      indicatorParams: { rsi: { period: 21 }, bollinger: { period: 30, std_mul: 3 } },
    });
    const b = computeInputHash({
      ...BASE,
      indicatorParams: { bollinger: { period: 30, std_mul: 3 }, rsi: { period: 21 } },
    });
    expect(a).toBe(b);
  });

  test("indicatorParams in HashInput affects hash", () => {
    const h1 = computeInputHash({ ...BASE, indicatorParams: { rsi: { period: 14 } } });
    const h2 = computeInputHash({ ...BASE, indicatorParams: { rsi: { period: 21 } } });
    expect(h1).not.toBe(h2);
  });
});
