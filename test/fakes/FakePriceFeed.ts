import type { PriceFeed, PriceTick } from "@domain/ports/PriceFeed";

export class FakePriceFeed implements PriceFeed {
  readonly source = "fake";
  private queue: PriceTick[] = [];
  private resolver: ((tick: PriceTick | null) => void) | null = null;

  async *subscribe(_args: { watchId: string; assets: string[] }): AsyncIterable<PriceTick> {
    while (true) {
      const tick =
        this.queue.shift() ??
        (await new Promise<PriceTick | null>((r) => {
          this.resolver = r;
        }));
      if (tick === null) return;
      yield tick;
    }
  }

  /** Test util: push a tick to subscribers */
  emit(tick: PriceTick): void {
    if (this.resolver) {
      this.resolver(tick);
      this.resolver = null;
    } else {
      this.queue.push(tick);
    }
  }

  /** Test util: terminate the stream */
  end(): void {
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
}
