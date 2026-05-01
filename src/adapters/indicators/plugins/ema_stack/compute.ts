import type { Candle } from "@domain/schemas/Candle";
import { ema, emaSeriesAligned } from "../base/math";

export type EmaStackParams = { period_short: number; period_mid: number; period_long: number };
export const EMA_STACK_DEFAULT_PARAMS: EmaStackParams = {
  period_short: 20,
  period_mid: 50,
  period_long: 200,
};

function readPeriods(params?: Record<string, unknown>): EmaStackParams {
  const short = params?.period_short;
  const mid = params?.period_mid;
  const long = params?.period_long;
  return {
    period_short: typeof short === "number" ? short : EMA_STACK_DEFAULT_PARAMS.period_short,
    period_mid: typeof mid === "number" ? mid : EMA_STACK_DEFAULT_PARAMS.period_mid,
    period_long: typeof long === "number" ? long : EMA_STACK_DEFAULT_PARAMS.period_long,
  };
}

export function computeScalars(candles: Candle[], params?: Record<string, unknown>) {
  const closes = candles.map((c) => c.close);
  const { period_short, period_mid, period_long } = readPeriods(params);
  return {
    ema20: ema(closes, period_short),
    ema50: ema(closes, period_mid),
    ema200: ema(closes, period_long),
  };
}
export function computeSeries(candles: Candle[], params?: Record<string, unknown>) {
  const closes = candles.map((c) => c.close);
  const n = candles.length;
  const { period_short, period_mid, period_long } = readPeriods(params);
  return {
    ema20: emaSeriesAligned(closes, period_short, n),
    ema50: emaSeriesAligned(closes, period_mid, n),
    ema200: emaSeriesAligned(closes, period_long, n),
  };
}
