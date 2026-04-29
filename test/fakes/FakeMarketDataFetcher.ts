import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Candle } from "@domain/schemas/Candle";

export class FakeMarketDataFetcher implements MarketDataFetcher {
  readonly source = "fake";
  candles: Candle[] = [];
  callsLog: { asset: string; timeframe: string; limit: number; endTime?: Date }[] = [];
  rangeCallsLog: { asset: string; timeframe: string; from: Date; to: Date }[] = [];
  private seeded = new Map<string, Candle[]>();

  async fetchOHLCV(args: {
    asset: string;
    timeframe: string;
    limit: number;
    endTime?: Date;
  }): Promise<Candle[]> {
    this.callsLog.push(args);
    const seededKey = this.makeKey(args.asset, args.timeframe);
    const seededList = this.seeded.get(seededKey);
    if (seededList) return seededList.slice(-args.limit);
    return this.candles.slice(-args.limit);
  }

  async fetchRange(args: {
    asset: string;
    timeframe: string;
    from: Date;
    to: Date;
  }): Promise<Candle[]> {
    this.rangeCallsLog.push(args);
    const seededKey = this.makeKey(args.asset, args.timeframe);
    const list = this.seeded.get(seededKey) ?? this.candles;
    return list.filter(
      (c) =>
        c.timestamp.getTime() >= args.from.getTime() && c.timestamp.getTime() <= args.to.getTime(),
    );
  }

  async isAssetSupported(_asset: string): Promise<boolean> {
    return true;
  }

  /**
   * Test util: pre-seed candles for a specific (asset, timeframe). Useful
   * for feedback context provider tests that need deterministic windows.
   */
  seed(asset: string, timeframe: string, candles: Candle[]): void {
    this.seeded.set(this.makeKey(asset, timeframe), [...candles]);
  }

  private makeKey(asset: string, timeframe: string): string {
    return `${asset}::${timeframe}`;
  }

  /** Test util: deterministic candle generator for synthetic scenarios */
  static generateLinear(count: number, startPrice = 100): Candle[] {
    const candles: Candle[] = [];
    let price = startPrice;
    const start = Date.now() - count * 3_600_000;
    for (let i = 0; i < count; i++) {
      const open = price;
      const close = price + Math.sin(i / 10) * 5;
      candles.push({
        timestamp: new Date(start + i * 3_600_000),
        open,
        high: Math.max(open, close) + 1,
        low: Math.min(open, close) - 1,
        close,
        volume: 100 + Math.abs(Math.sin(i / 5)) * 200,
      });
      price = close;
    }
    return candles;
  }
}
