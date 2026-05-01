import type { Candle } from "@domain/schemas/Candle";
import { vwapSeriesAligned } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const series = vwapSeriesAligned(candles);
  const vwap = series[series.length - 1] ?? candles[candles.length - 1]?.close ?? 0;
  const lastClose = candles[candles.length - 1]?.close ?? 0;
  const priceVsVwapPct = vwap === 0 ? 0 : ((lastClose - vwap) / vwap) * 100;
  return { vwapSession: vwap, priceVsVwapPct };
}

export function computeSeries(candles: Candle[]) {
  const raw = vwapSeriesAligned(candles);
  // Null out 2 consecutive points around session boundaries to reliably
  // break the line in lightweight-charts (single null gets bridged).
  const dayOf = (i: number) => {
    const c = candles[i];
    return c ? Math.floor(c.timestamp.getTime() / 86_400_000) : -1;
  };
  const gapped: (number | null)[] = raw.map((v, i) => {
    if (i === 0) return v;
    const dCur = dayOf(i);
    const dPrev = dayOf(i - 1);
    const dNext = i + 1 < raw.length ? dayOf(i + 1) : dCur;
    // Null at the LAST point of session N (next candle starts a new day)
    // AND at the FIRST point of session N+1 (this candle is a new day vs prev).
    if (dCur !== dPrev) return null;
    if (dNext !== dCur) return null;
    return v;
  });
  return { vwap: gapped };
}
