import type { FundingRateProvider, FundingSnapshot } from "@domain/ports/FundingRateProvider";

/**
 * Test fake. Defaults to returning null for every symbol (the common
 * unsupported-asset path). Tests can configure per-symbol snapshots via
 * `set(symbol, snapshot)` or always-on via `setAll(snapshot)`.
 */
export class FakeFundingRateProvider implements FundingRateProvider {
  readonly source = "fake_funding";
  private bySymbol = new Map<string, FundingSnapshot | null>();
  private fallback: FundingSnapshot | null = null;
  /** Symbols asked about (for assertion). */
  fetchLog: string[] = [];

  set(symbol: string, snapshot: FundingSnapshot | null): void {
    this.bySymbol.set(symbol.toUpperCase(), snapshot);
  }

  setAll(snapshot: FundingSnapshot | null): void {
    this.fallback = snapshot;
  }

  async fetchSnapshot(asset: string): Promise<FundingSnapshot | null> {
    const sym = asset.toUpperCase();
    this.fetchLog.push(sym);
    if (this.bySymbol.has(sym)) return this.bySymbol.get(sym) ?? null;
    return this.fallback;
  }
}

/** Convenience factory: a "reasonable" snapshot for tests that just need data present. */
export function makeFundingSnapshot(overrides: Partial<FundingSnapshot> = {}): FundingSnapshot {
  return {
    lastFundingRatePct: 0.01,
    lastFundingAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
    nextFundingAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
    avg7dFundingRatePct: 0.012,
    openInterest: 100_000,
    openInterest24hDeltaPct: 1.5,
    ...overrides,
  };
}
