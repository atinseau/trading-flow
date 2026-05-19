import { describe, expect, test } from "bun:test";
import { allocatePanes } from "@adapters/chart/paneAllocator";

const ind = (id: string, pane: "price_overlay" | "secondary", stretch?: number) => ({
  id,
  pane,
  secondaryPaneStretch: stretch,
});

describe("allocatePanes", () => {
  test("all price_overlay → only main pane", () => {
    const out = allocatePanes([ind("ema", "price_overlay"), ind("bb", "price_overlay")], {
      ema: true,
      bb: true,
    });
    expect(out.assignments).toEqual({ ema: 0, bb: 0 });
    expect(out.stretches).toEqual([[0, 50]]);
  });

  test("two secondaries → main + 2 panes, stretches preserved", () => {
    const out = allocatePanes([ind("rsi", "secondary", 13), ind("macd", "secondary", 15)], {
      rsi: true,
      macd: true,
    });
    expect(out.assignments).toEqual({ rsi: 1, macd: 2 });
    expect(out.stretches).toEqual([
      [0, 50],
      [1, 13],
      [2, 15],
    ]);
  });

  test("hidden indicator is skipped → pane index shifts", () => {
    const out = allocatePanes([ind("rsi", "secondary", 13), ind("macd", "secondary", 15)], {
      rsi: false,
      macd: true,
    });
    expect(out.assignments).toEqual({ macd: 1 });
    expect(out.stretches).toEqual([
      [0, 50],
      [1, 15],
    ]);
  });

  test("default stretch is 13 when secondaryPaneStretch omitted", () => {
    const out = allocatePanes([ind("rsi", "secondary")], { rsi: true });
    expect(out.stretches).toEqual([
      [0, 50],
      [1, 13],
    ]);
  });

  test("input order is preserved (deterministic)", () => {
    const out = allocatePanes([ind("macd", "secondary", 15), ind("rsi", "secondary", 13)], {
      macd: true,
      rsi: true,
    });
    expect(out.assignments).toEqual({ macd: 1, rsi: 2 });
  });
});
