import { describe, expect, test } from "bun:test";
import { computeRightOffset } from "@adapters/chart/computeRightOffset";

describe("computeRightOffset", () => {
  test("≤ 5 labels → offset 5", () => {
    expect(computeRightOffset({ priceOverlayLineCount: 0, priceLineCount: 0 })).toBe(5);
    expect(computeRightOffset({ priceOverlayLineCount: 3, priceLineCount: 2 })).toBe(5);
  });
  test("6-10 labels → offset 8", () => {
    expect(computeRightOffset({ priceOverlayLineCount: 4, priceLineCount: 2 })).toBe(8);
    expect(computeRightOffset({ priceOverlayLineCount: 6, priceLineCount: 4 })).toBe(8);
  });
  test("11-15 labels → offset 12", () => {
    expect(computeRightOffset({ priceOverlayLineCount: 7, priceLineCount: 4 })).toBe(12);
    expect(computeRightOffset({ priceOverlayLineCount: 10, priceLineCount: 5 })).toBe(12);
  });
  test("16+ labels caps at 16", () => {
    expect(computeRightOffset({ priceOverlayLineCount: 10, priceLineCount: 6 })).toBe(16);
    expect(computeRightOffset({ priceOverlayLineCount: 50, priceLineCount: 50 })).toBe(16);
  });
});
