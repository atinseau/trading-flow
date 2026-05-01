import type { Candle } from "@domain/schemas/Candle";
import { macdSeriesAligned } from "../base/math";

export type MacdParams = { fast: number; slow: number; signal: number };
export const MACD_DEFAULT_PARAMS: MacdParams = { fast: 12, slow: 26, signal: 9 };

function readParams(params?: Record<string, unknown>): MacdParams {
  const fast = params?.fast;
  const slow = params?.slow;
  const signal = params?.signal;
  return {
    fast: typeof fast === "number" ? fast : MACD_DEFAULT_PARAMS.fast,
    slow: typeof slow === "number" ? slow : MACD_DEFAULT_PARAMS.slow,
    signal: typeof signal === "number" ? signal : MACD_DEFAULT_PARAMS.signal,
  };
}

export function computeScalars(candles: Candle[], params?: Record<string, unknown>) {
  const closes = candles.map((c) => c.close);
  const { fast, slow, signal } = readParams(params);
  const series = macdSeriesAligned(closes, fast, slow, signal);
  const last = (a: (number | null)[]) => a[a.length - 1] ?? 0;
  return { macd: last(series.macd), macdSignal: last(series.signal), macdHist: last(series.hist) };
}
export function computeSeries(candles: Candle[], params?: Record<string, unknown>) {
  const { fast, slow, signal } = readParams(params);
  return macdSeriesAligned(candles.map((c) => c.close), fast, slow, signal);
}
