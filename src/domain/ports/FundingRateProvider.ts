/**
 * Provider for crypto-derivatives funding/positioning data. Independent of
 * the spot `MarketDataFetcher` because:
 *  - Only crypto (perp futures) — Yahoo / equities have no funding concept.
 *  - Only certain assets per source (a Binance perp must exist for the
 *    symbol; not every spot pair has a perp).
 *  - The data reads on a different cadence than OHLCV and from a different
 *    endpoint shape (Binance: /fapi/v1/*).
 *
 * Returns null when the symbol has no perp or the provider doesn't cover it
 * — callers (reviewer/finalizer prompts) treat null as "not available" and
 * skip the section.
 */
export type FundingSnapshot = {
  /** Last realized funding rate (8h cycle on Binance), pct of notional. */
  lastFundingRatePct: number;
  /** ISO timestamp of when that rate was paid. */
  lastFundingAt: string;
  /** Next scheduled funding (ISO). */
  nextFundingAt: string;
  /**
   * Funding-rate average over the last 7 cycles (rolling-mean indicator
   * used to spot persistent positioning bias).
   */
  avg7dFundingRatePct: number;
  /** Current open interest in base-currency units. */
  openInterest: number;
  /**
   * 24h delta (% change) of open interest — captures regime shifts:
   * positive on a price drop = new shorts piling in (confirmation).
   */
  openInterest24hDeltaPct: number;
};

export interface FundingRateProvider {
  /** Source identifier ("binance_futures"). */
  readonly source: string;
  /**
   * Resolve a snapshot for the given asset. `null` if the asset has no
   * matching perpetual, or the upstream API failed (callers should not
   * block decisions on funding data).
   */
  fetchSnapshot(asset: string): Promise<FundingSnapshot | null>;
}
