import { safeHandler, ValidationError } from "./safeHandler";
import { fetchOhlcv } from "../lib/marketData";

const VALID_INTERVALS = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"] as const;
const VALID_SOURCES = ["binance", "yahoo"] as const;

export const assetOhlcv = safeHandler(async (req) => {
  const params = (req as Request & { params?: Record<string, string> }).params ?? {};
  const source = params.source as (typeof VALID_SOURCES)[number] | undefined;
  const symbol = params.symbol;
  if (!source || !VALID_SOURCES.includes(source)) {
    throw new ValidationError("source must be 'binance' or 'yahoo'");
  }
  if (!symbol) throw new ValidationError("symbol required");

  const url = new URL(req.url);
  const interval = url.searchParams.get("interval") ?? "1h";
  if (!VALID_INTERVALS.includes(interval as (typeof VALID_INTERVALS)[number])) {
    throw new ValidationError(`interval must be one of: ${VALID_INTERVALS.join(", ")}`);
  }
  const limit = Math.min(1000, Math.max(10, Number(url.searchParams.get("limit") ?? 200)));

  const candles = await fetchOhlcv({ source, symbol, interval, limit });
  return Response.json({ source, symbol, interval, candles });
});
