import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import type { Candle } from "@domain/schemas/Candle";

// 50 deterministic candles — enough headroom for RSI (14), EMA stack, MACD, etc.
const candles: Candle[] = Array.from({ length: 50 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100 + Math.sin(i / 5) * 10,
  high: 100 + Math.sin(i / 5) * 10 + 5,
  low: 100 + Math.sin(i / 5) * 10 - 5,
  close: 100 + Math.sin((i + 1) / 5) * 10,
  volume: 1000 + i * 10,
}));

describe("PlaywrightChartRenderer visual regression", () => {
  let renderer: PlaywrightChartRenderer;
  let registry: IndicatorRegistry;
  let calc: PureJsIndicatorCalculator;
  let outDir: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "tf-chart-regression-"));
    registry = new IndicatorRegistry();
    calc = new PureJsIndicatorCalculator();
    renderer = new PlaywrightChartRenderer(registry, { poolSize: 1 });
    await renderer.warmUp();
  }, 30_000);

  afterAll(async () => {
    await renderer.dispose();
    await rm(outDir, { recursive: true, force: true });
  });

  test("naked render — no indicators, produces valid PNG", async () => {
    const result = await renderer.render({
      candles,
      series: {},
      enabledIndicatorIds: [],
      width: 1280,
      height: 900,
      outputUri: `file://${join(outDir, "naked.png")}`,
    });

    expect(result.bytes).toBeGreaterThan(2000);
    expect(result.bytes).toBeLessThan(200_000);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.mimeType).toBe("image/png");

    const buffer = await Bun.file(result.uri.replace(/^file:\/\//, "")).bytes();
    expect(buffer.length).toBe(result.bytes);
    // PNG magic bytes (89 50 4E 47)
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
    expect(buffer[2]).toBe(0x4e);
    expect(buffer[3]).toBe(0x47);
  }, 30_000);

  test("recommended render — RSI, EMA stack, Volume, Swings/BOS", async () => {
    const plugins = registry.resolveActive({
      rsi: { enabled: true },
      ema_stack: { enabled: true },
      volume: { enabled: true },
      swings_bos: { enabled: true },
    });
    const series = await calc.computeSeries(candles, plugins);
    const result = await renderer.render({
      candles,
      series,
      enabledIndicatorIds: plugins.map((p) => p.id),
      width: 1280,
      height: 720,
      outputUri: `file://${join(outDir, "recommended.png")}`,
    });

    expect(result.bytes).toBeGreaterThan(2000);
    expect(result.bytes).toBeLessThan(300_000);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.mimeType).toBe("image/png");
  }, 30_000);

  test("full render — all 12 plugins active", async () => {
    const plugins = registry.all();
    const matrix = Object.fromEntries(plugins.map((p) => [p.id, { enabled: true }]));
    const active = registry.resolveActive(matrix as Parameters<typeof registry.resolveActive>[0]);
    const series = await calc.computeSeries(candles, active);
    const result = await renderer.render({
      candles,
      series,
      enabledIndicatorIds: active.map((p) => p.id),
      width: 1280,
      height: 720,
      outputUri: `file://${join(outDir, "full.png")}`,
    });

    expect(result.bytes).toBeGreaterThan(2000);
    expect(result.bytes).toBeLessThan(500_000);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.mimeType).toBe("image/png");
  }, 30_000);

  test("rendering same candles twice produces ~identical sizes (within 5%)", async () => {
    const a = await renderer.render({
      candles,
      series: {},
      enabledIndicatorIds: [],
      width: 800,
      height: 600,
      outputUri: `file://${join(outDir, "twice-a.png")}`,
    });
    const b = await renderer.render({
      candles,
      series: {},
      enabledIndicatorIds: [],
      width: 800,
      height: 600,
      outputUri: `file://${join(outDir, "twice-b.png")}`,
    });

    expect(Math.abs(a.bytes - b.bytes) / Math.max(a.bytes, b.bytes)).toBeLessThan(0.05);
  }, 30_000);

  test("rendering empty candles array produces a valid PNG without crashing", async () => {
    const result = await renderer.render({
      candles: [],
      series: {},
      enabledIndicatorIds: [],
      width: 800,
      height: 600,
      outputUri: `file://${join(outDir, "empty.png")}`,
    });

    expect(result.bytes).toBeGreaterThan(1000);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);
});
