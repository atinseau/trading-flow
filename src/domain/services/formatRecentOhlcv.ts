import type { Candle } from "@domain/schemas/Candle";

export type RecentOhlcvOpts = {
  /** Number of bars to emit (oldest → newest). Truncated if longer than
   *  available candles. `0` returns an empty string (caller can skip). */
  count: number;
  /** Decimal places for O/H/L/C. `null` → auto-detect from last close
   *  (≥1000 → 2, ≥10 → 3, ≥1 → 4, else 5). */
  decimals: number | null;
  /** Time column format. */
  timestampFormat: "iso" | "relative" | "time";
  /** Include the `V` (volume) column. */
  includeVolume: boolean;
};

/**
 * Render the last N candles as a Markdown table the LLM can read in
 * the same way it reads any other table. Complements the chart image
 * with numerical precision the image's pixel grid can't carry.
 *
 * Returns an empty string when `count === 0` or `candles.length === 0`
 * — the caller is responsible for skipping the surrounding header /
 * section in the prompt template.
 *
 * Truth-table is fully testable in isolation ; no LLM, no DB, no I/O.
 */
export function formatRecentOhlcv(candles: ReadonlyArray<Candle>, opts: RecentOhlcvOpts): string {
  if (opts.count === 0 || candles.length === 0) return "";

  const slice = candles.slice(-opts.count);
  const total = slice.length;
  const decimals = opts.decimals ?? autoDecimals(slice[slice.length - 1]?.close ?? 0);

  const header = opts.includeVolume
    ? "| # | time | O | H | L | C | V |\n|---|---|---|---|---|---|---|"
    : "| # | time | O | H | L | C |\n|---|---|---|---|---|---|";

  const rows: string[] = [];
  for (let i = 0; i < total; i++) {
    const c = slice[i] as Candle;
    const idx = -(total - 1 - i);
    const time = formatTimestamp(c.timestamp, opts.timestampFormat, idx);
    const o = c.open.toFixed(decimals);
    const h = c.high.toFixed(decimals);
    const l = c.low.toFixed(decimals);
    const cl = c.close.toFixed(decimals);
    if (opts.includeVolume) {
      const v = formatVolume(c.volume);
      rows.push(`| ${idx} | ${time} | ${o} | ${h} | ${l} | ${cl} | ${v} |`);
    } else {
      rows.push(`| ${idx} | ${time} | ${o} | ${h} | ${l} | ${cl} |`);
    }
  }
  return `${header}\n${rows.join("\n")}`;
}

function autoDecimals(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 1000) return 2;
  if (abs >= 10) return 3;
  if (abs >= 1) return 4;
  return 5;
}

function formatTimestamp(d: Date, fmt: RecentOhlcvOpts["timestampFormat"], idx: number): string {
  switch (fmt) {
    case "iso":
      return d.toISOString().replace(".000Z", "Z");
    case "time": {
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      const mon = String(d.getUTCMonth() + 1).padStart(2, "0");
      return `${mon}-${day} ${hh}:${mm}`;
    }
    case "relative":
      return idx === 0 ? "now" : `${idx}`;
  }
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}k`;
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(4);
}
