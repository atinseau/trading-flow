import type { PriceFeed, PriceTick } from "@domain/ports/PriceFeed";

function tradeMessageToTick(message: unknown): PriceTick | null {
  const obj = message as { data?: { s?: string; p?: string; T?: number } };
  if (!obj.data?.s || !obj.data.p || !obj.data.T) return null;
  return {
    asset: obj.data.s,
    price: Number.parseFloat(obj.data.p),
    timestamp: new Date(obj.data.T),
  };
}

export class BinanceWsPriceFeed implements PriceFeed {
  readonly source = "binance_ws";

  constructor(private opts: { baseUrl?: string } = {}) {}

  async *subscribe(args: { watchId: string; assets: string[] }): AsyncIterable<PriceTick> {
    const streams = args.assets.map((a) => `${a.toLowerCase()}@trade`).join("/");
    const url = `${this.opts.baseUrl ?? "wss://stream.binance.com:9443"}/stream?streams=${streams}`;

    const ws = new WebSocket(url);
    const queue: PriceTick[] = [];
    let resolver: ((v: PriceTick | null) => void) | null = null;
    let closed = false;

    ws.addEventListener("message", (msg) => {
      try {
        const data = JSON.parse((msg as MessageEvent).data as string);
        const tick = tradeMessageToTick(data);
        if (tick) {
          if (resolver) {
            resolver(tick);
            resolver = null;
          } else {
            queue.push(tick);
          }
        }
      } catch {
        /* ignore malformed */
      }
    });

    ws.addEventListener("close", () => {
      closed = true;
      if (resolver) {
        resolver(null);
        resolver = null;
      }
    });

    try {
      while (!closed || queue.length > 0) {
        const tick =
          queue.shift() ??
          (await new Promise<PriceTick | null>((r) => {
            resolver = r;
          }));
        if (tick === null) return;
        yield tick;
      }
    } finally {
      ws.close();
    }
  }
}
