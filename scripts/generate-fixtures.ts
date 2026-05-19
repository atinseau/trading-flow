// scripts/generate-fixtures.ts — one-off fixture generator. Not committed; output JSONs are.
import { mkdir } from "node:fs/promises";

await mkdir("test/fixtures/candles", { recursive: true });

function gen(seed = 0, trend = 1) {
  const out: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];
  let price = 100;
  let t = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);
  for (let i = 0; i < 200; i++) {
    const drift = trend * 0.05;
    const noise = (((seed + i * 9301 + 49297) % 233280) / 233280 - 0.5) * 2;
    const open = price;
    const close = price + drift + noise;
    const high = Math.max(open, close) + Math.abs(noise) * 0.5;
    const low = Math.min(open, close) - Math.abs(noise) * 0.5;
    out.push({ time: t, open, high, low, close, volume: 1000 + Math.abs(noise) * 100 });
    price = close;
    t += 3600;
  }
  return out;
}

await Bun.write(
  "test/fixtures/candles/btcusdt-1h-bullish-200.json",
  JSON.stringify(gen(0, 1), null, 2),
);
await Bun.write(
  "test/fixtures/candles/btcusdt-1h-bearish-200.json",
  JSON.stringify(gen(7, -1), null, 2),
);
console.log("Generated fixtures.");
