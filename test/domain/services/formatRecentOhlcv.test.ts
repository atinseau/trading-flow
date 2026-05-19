import { describe, expect, test } from "bun:test";
import { formatRecentOhlcv } from "@domain/services/formatRecentOhlcv";
import type { Candle } from "@domain/schemas/Candle";

function mkCandle(isoTime: string, c: number, v = 100): Candle {
  return {
    timestamp: new Date(isoTime),
    open: c - 5,
    high: c + 10,
    low: c - 10,
    close: c,
    volume: v,
  };
}

describe("formatRecentOhlcv", () => {
  test("count=0 → empty string (caller skips the section)", () => {
    const out = formatRecentOhlcv([mkCandle("2026-05-19T12:00:00Z", 100)], {
      count: 0,
      decimals: 2,
      timestampFormat: "time",
      includeVolume: true,
    });
    expect(out).toBe("");
  });

  test("empty candles → empty string", () => {
    const out = formatRecentOhlcv([], {
      count: 50,
      decimals: 2,
      timestampFormat: "time",
      includeVolume: true,
    });
    expect(out).toBe("");
  });

  test("rounds to requested decimals and labels oldest-first with negative indices", () => {
    const candles = [
      mkCandle("2026-05-19T15:00:00Z", 76800.123456),
      mkCandle("2026-05-19T15:15:00Z", 76900.987654),
      mkCandle("2026-05-19T15:30:00Z", 76850.0),
    ];
    const out = formatRecentOhlcv(candles, {
      count: 3,
      decimals: 2,
      timestampFormat: "time",
      includeVolume: true,
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("| # | time | O | H | L | C | V |");
    expect(lines[1]).toBe("|---|---|---|---|---|---|---|");
    expect(lines[2]).toContain("| -2 | 05-19 15:00 | 76795.12 | 76810.12 | 76790.12 | 76800.12 |");
    expect(lines[3]).toContain("| -1 | 05-19 15:15 | 76895.99 | 76910.99 | 76890.99 | 76900.99 |");
    expect(lines[4]).toContain("| 0 | 05-19 15:30 | 76845.00 | 76860.00 | 76840.00 | 76850.00 |");
  });

  test("truncates to last N when candles exceed count", () => {
    const candles = Array.from({ length: 10 }, (_, i) =>
      mkCandle(`2026-05-19T1${i}:00:00Z`, 100 + i),
    );
    const out = formatRecentOhlcv(candles, {
      count: 3,
      decimals: 2,
      timestampFormat: "relative",
      includeVolume: false,
    });
    const lines = out.split("\n").filter((l) => l.startsWith("|"));
    // header + separator + 3 rows
    expect(lines.length).toBe(5);
    expect(lines[2]).toContain("| -2 ");
    expect(lines[3]).toContain("| -1 ");
    expect(lines[4]).toContain("| 0 | now ");
  });

  test("auto decimals: BTC (~76k) → 2, EURUSD (~1.08) → 4, BNT (~0.5) → 5", () => {
    const btc = formatRecentOhlcv([mkCandle("2026-05-19T15:00:00Z", 76123.456)], {
      count: 1,
      decimals: null,
      timestampFormat: "time",
      includeVolume: false,
    });
    expect(btc).toContain("76123.46"); // 2 decimals

    const eurusd = formatRecentOhlcv([mkCandle("2026-05-19T15:00:00Z", 1.08234)], {
      count: 1,
      decimals: null,
      timestampFormat: "time",
      includeVolume: false,
    });
    expect(eurusd).toMatch(/1\.0823/); // 4 decimals — 1.082 rounded

    const bnt = formatRecentOhlcv([mkCandle("2026-05-19T15:00:00Z", 0.5123)], {
      count: 1,
      decimals: null,
      timestampFormat: "time",
      includeVolume: false,
    });
    expect(bnt).toMatch(/0\.51230/); // 5 decimals
  });

  test("includeVolume=false drops the V column from header + rows", () => {
    const out = formatRecentOhlcv([mkCandle("2026-05-19T15:00:00Z", 100)], {
      count: 1,
      decimals: 2,
      timestampFormat: "time",
      includeVolume: false,
    });
    expect(out).not.toContain("| V ");
    expect(out.split("\n")[0]).toBe("| # | time | O | H | L | C |");
  });

  test("volume formatter: M / k / unit / micro", () => {
    const out = formatRecentOhlcv(
      [
        mkCandle("2026-05-19T15:00:00Z", 100, 2_500_000),
        mkCandle("2026-05-19T15:15:00Z", 100, 2500),
        mkCandle("2026-05-19T15:30:00Z", 100, 12.5),
        mkCandle("2026-05-19T15:45:00Z", 100, 0.0123),
      ],
      { count: 4, decimals: 2, timestampFormat: "time", includeVolume: true },
    );
    const lines = out.split("\n").filter((l) => l.startsWith("|"));
    expect(lines[2]).toContain("| 2.50M |");
    expect(lines[3]).toContain("| 2.50k |");
    expect(lines[4]).toContain("| 12.50 |");
    expect(lines[5]).toContain("| 0.0123 |");
  });

  test("timestamp_format: iso", () => {
    const out = formatRecentOhlcv([mkCandle("2026-05-19T15:00:00Z", 100)], {
      count: 1,
      decimals: 2,
      timestampFormat: "iso",
      includeVolume: false,
    });
    expect(out).toContain("2026-05-19T15:00:00Z");
  });

  test("timestamp_format: relative emits 'now' for the last candle", () => {
    const out = formatRecentOhlcv(
      [
        mkCandle("2026-05-19T15:00:00Z", 100),
        mkCandle("2026-05-19T15:15:00Z", 101),
      ],
      { count: 2, decimals: 2, timestampFormat: "relative", includeVolume: false },
    );
    const lines = out.split("\n").filter((l) => l.startsWith("|"));
    expect(lines[2]).toContain("| -1 ");
    expect(lines[3]).toContain("| 0 | now ");
  });
});
