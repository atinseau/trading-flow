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

export type SessionState = {
  isOpen: boolean;
  nextOpenAt?: Date;
  nextCloseAt?: Date;
};

export function getSessionState(session: Session, now: Date): SessionState {
  if (session.kind === "always-open") return { isOpen: true };
  if (session.kind === "exchange") return computeExchangeState(session.id, now);
  if (session.kind === "forex") return computeForexState(now);
  // exhaustive — should never reach here
  const _exhaustive: never = session;
  return _exhaustive;
}

// Stubs — implemented in Tasks 1.4 and 1.5
function computeExchangeState(_id: ExchangeId, _now: Date): SessionState {
  throw new Error("computeExchangeState not implemented (Task 1.4)");
}
function computeForexState(_now: Date): SessionState {
  throw new Error("computeForexState not implemented (Task 1.5)");
}
