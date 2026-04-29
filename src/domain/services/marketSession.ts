import { UnsupportedExchangeError } from "@domain/errors";
import { type ExchangeId, normalizeYahooExchange } from "./exchangeCalendars";

export type Session =
  | { kind: "always-open" }
  | { kind: "exchange"; id: ExchangeId }
  | { kind: "forex" };

export type WatchAssetInput = {
  asset: {
    source: string;
    symbol: string;
    quoteType?: string;
    exchange?: string;
  };
};

export function getSession(watch: WatchAssetInput): Session {
  if (watch.asset.source === "binance") return { kind: "always-open" };
  switch (watch.asset.quoteType) {
    case "CURRENCY":
      return { kind: "forex" };
    case "FUTURE":
    case "CRYPTOCURRENCY":
      return { kind: "always-open" };
    case "EQUITY":
    case "ETF":
    case "INDEX": {
      const id = normalizeYahooExchange(watch.asset.exchange);
      if (!id) throw new UnsupportedExchangeError(watch.asset.exchange);
      return { kind: "exchange", id };
    }
    default:
      throw new Error(`Unsupported quoteType: ${watch.asset.quoteType}`);
  }
}
