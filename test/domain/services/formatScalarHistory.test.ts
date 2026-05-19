import { describe, expect, test } from "bun:test";
import { formatScalarHistory } from "@domain/services/formatScalarHistory";

describe("formatScalarHistory", () => {
  test("empty / undefined → empty string (caller skips the line)", () => {
    expect(formatScalarHistory(undefined)).toBe("");
    expect(formatScalarHistory([])).toBe("");
  });

  test("numbers joined with ' → ' at given decimals", () => {
    expect(formatScalarHistory([42.3, 45.1, 48.0, 51.234], { decimals: 2 })).toBe(
      "42.30 → 45.10 → 48.00 → 51.23",
    );
  });

  test("nulls become '—'", () => {
    expect(formatScalarHistory([null, 45.1, null, 51.2], { decimals: 1 })).toBe(
      "— → 45.1 → — → 51.2",
    );
  });

  test("max trims to the last N values", () => {
    expect(
      formatScalarHistory([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { decimals: 0, max: 3 }),
    ).toBe("8 → 9 → 10");
  });

  test("NaN treated like null", () => {
    expect(formatScalarHistory([Number.NaN, 1.5], { decimals: 2 })).toBe("— → 1.50");
  });
});
