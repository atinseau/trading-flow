import type { FundingRateProvider, FundingSnapshot } from "@domain/ports/FundingRateProvider";
import { getLogger } from "@observability/logger";

const log = getLogger({ component: "binance-funding-provider" });

const BASE = "https://fapi.binance.com";

/** Per-symbol circuit-breaker thresholds. */
const FAILURE_THRESHOLD = 3; // open after N consecutive failures
const COOLDOWN_MS = 5 * 60_000; // 5min — tunable; covers Binance's typical 1m+ ban window for fapi
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000; // 15min — 429 / 418 should back off harder

type CircuitState = {
  failures: number;
  openedUntil: number; // epoch ms; 0 = closed
};

/**
 * Binance USD-M futures provider for funding-rate + open-interest data.
 * Public endpoints, no credentials. USDT-margined perps only.
 *
 * Resilience:
 * - Per-endpoint failures don't poison the snapshot — partial data is still
 *   useful (`Promise.allSettled`).
 * - Per-symbol circuit breaker: after N consecutive failures (or any 429/418),
 *   skip fetches for `COOLDOWN_MS` to avoid hammering a banned IP.
 * - Network/parse errors return null at the provider level, never throw — the
 *   reviewer/finalizer prompts gracefully omit the funding block.
 */
export class BinanceFundingRateProvider implements FundingRateProvider {
  readonly source = "binance_futures";
  private circuits = new Map<string, CircuitState>();

  async fetchSnapshot(asset: string): Promise<FundingSnapshot | null> {
    const symbol = asset.toUpperCase();
    if (this.isCircuitOpen(symbol)) return null;

    const results = await Promise.allSettled([
      this.fetchJson<Array<{ fundingRate: string; fundingTime: number }>>(
        symbol,
        `${BASE}/fapi/v1/fundingRate?symbol=${symbol}&limit=21`,
      ),
      this.fetchJson<{ nextFundingTime: number }>(
        symbol,
        `${BASE}/fapi/v1/premiumIndex?symbol=${symbol}`,
      ),
      this.fetchJson<{ openInterest: string }>(
        symbol,
        `${BASE}/fapi/v1/openInterest?symbol=${symbol}`,
      ),
      this.fetchJson<Array<{ sumOpenInterest: string; timestamp: number }>>(
        symbol,
        `${BASE}/futures/data/openInterestHist?symbol=${symbol}&period=1d&limit=2`,
      ),
    ]);

    const fundingRows = results[0].status === "fulfilled" ? results[0].value : null;
    const premiumIndex = results[1].status === "fulfilled" ? results[1].value : null;
    const oiNow = results[2].status === "fulfilled" ? results[2].value : null;
    const oi24hRows = results[3].status === "fulfilled" ? results[3].value : null;

    // Funding rate is the minimum-viable signal. If we can't get the funding
    // history, the snapshot is useless — return null. OI is degradable.
    if (!fundingRows || fundingRows.length === 0) {
      this.recordFailure(symbol);
      return null;
    }
    const last = fundingRows[fundingRows.length - 1];
    if (!last) {
      this.recordFailure(symbol);
      return null;
    }

    const lastFundingRatePct = Number(last.fundingRate) * 100;
    const recentRates = fundingRows.slice(-21).map((r) => Number(r.fundingRate));
    const avg7d =
      recentRates.length > 0
        ? (recentRates.reduce((a, b) => a + b, 0) / recentRates.length) * 100
        : lastFundingRatePct;

    // OI may be degraded; default to 0 / 0% if missing rather than nullify
    // the whole snapshot.
    const oiCurrent = oiNow ? Number(oiNow.openInterest) : 0;
    const oi24hAgo =
      oi24hRows && oi24hRows.length > 0
        ? Number(oi24hRows[0]?.sumOpenInterest ?? oiCurrent)
        : oiCurrent;
    const oiDeltaPct = oi24hAgo === 0 ? 0 : ((oiCurrent - oi24hAgo) / oi24hAgo) * 100;

    // Next funding time falls back to "8h from now" if premiumIndex failed —
    // best-effort estimate, the prompt formats it for context only.
    const nextFundingAt =
      premiumIndex?.nextFundingTime != null
        ? new Date(premiumIndex.nextFundingTime).toISOString()
        : new Date(Date.now() + 8 * 3600_000).toISOString();

    this.recordSuccess(symbol);
    return {
      lastFundingRatePct,
      lastFundingAt: new Date(last.fundingTime).toISOString(),
      nextFundingAt,
      avg7dFundingRatePct: avg7d,
      openInterest: oiCurrent,
      openInterest24hDeltaPct: oiDeltaPct,
    };
  }

  private isCircuitOpen(symbol: string): boolean {
    const c = this.circuits.get(symbol);
    if (!c || c.openedUntil === 0) return false;
    if (Date.now() >= c.openedUntil) {
      // Cooldown elapsed — reset and allow next request.
      c.openedUntil = 0;
      c.failures = 0;
      return false;
    }
    return true;
  }

  private recordFailure(symbol: string, rateLimited = false): void {
    const c = this.circuits.get(symbol) ?? { failures: 0, openedUntil: 0 };
    c.failures++;
    if (rateLimited) {
      c.openedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      log.warn(
        { symbol, cooldownMs: RATE_LIMIT_COOLDOWN_MS },
        "binance funding circuit OPEN (rate-limited)",
      );
    } else if (c.failures >= FAILURE_THRESHOLD) {
      c.openedUntil = Date.now() + COOLDOWN_MS;
      log.warn(
        { symbol, failures: c.failures, cooldownMs: COOLDOWN_MS },
        "binance funding circuit OPEN (consecutive failures)",
      );
    }
    this.circuits.set(symbol, c);
  }

  private recordSuccess(symbol: string): void {
    const c = this.circuits.get(symbol);
    if (c) {
      c.failures = 0;
      c.openedUntil = 0;
    }
  }

  private async fetchJson<T>(symbol: string, url: string): Promise<T | null> {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return (await res.json()) as T;
      // 429 / 418 / 403 = rate-limited or banned; trip the circuit hard.
      if (res.status === 429 || res.status === 418 || res.status === 403) {
        this.recordFailure(symbol, true);
        return null;
      }
      // 404/400 = unsupported symbol — non-error, not a circuit signal.
      if (res.status === 404 || res.status === 400) return null;
      log.warn({ url, status: res.status }, "binance non-2xx");
      return null;
    } catch (err) {
      log.warn({ url, err: (err as Error).message }, "binance fetch failed");
      return null;
    }
  }
}
