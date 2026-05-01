import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import type { Candle } from "@domain/schemas/Candle";

describe("PlaywrightChartRenderer visual regression", () => {
  let renderer: PlaywrightChartRenderer;
  let outDir: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "tf-chart-regression-"));
    renderer = new PlaywrightChartRenderer({ poolSize: 1 });
    await renderer.warmUp();
  }, 30_000);

  afterAll(async () => {
    await renderer.dispose();
    await rm(outDir, { recursive: true, force: true });
  });

  test("rendering deterministic candles produces non-empty, valid WebP", async () => {
    // Hand-crafted candle set — known values, fully deterministic.
    const candles: Candle[] = [
      {
        timestamp: new Date("2026-01-01T00:00:00Z"),
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 100,
      },
      {
        timestamp: new Date("2026-01-01T01:00:00Z"),
        open: 105,
        high: 115,
        low: 100,
        close: 112,
        volume: 150,
      },
      {
        timestamp: new Date("2026-01-01T02:00:00Z"),
        open: 112,
        high: 120,
        low: 108,
        close: 118,
        volume: 200,
      },
      {
        timestamp: new Date("2026-01-01T03:00:00Z"),
        open: 118,
        high: 125,
        low: 115,
        close: 122,
        volume: 180,
      },
      {
        timestamp: new Date("2026-01-01T04:00:00Z"),
        open: 122,
        high: 128,
        low: 119,
        close: 124,
        volume: 160,
      },
    ];

    const out = `file://${join(outDir, "regression.png")}`;
    const result = await renderer.render({
      candles,
      width: 800,
      height: 600,
      outputUri: out,
    });

    // Sanity: WebP must be valid.
    expect(result.bytes).toBeGreaterThan(500); // realistic compressed chart
    expect(result.bytes).toBeLessThan(200_000);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.mimeType).toBe("image/webp");
    expect(result.uri.endsWith(".webp")).toBe(true);

    // Verify the file exists on disk and matches the reported size.
    const buffer = await Bun.file(result.uri.replace(/^file:\/\//, "")).bytes();
    expect(buffer.length).toBe(result.bytes);

    // WebP container: bytes 0-3 = "RIFF", 8-11 = "WEBP".
    expect(buffer[0]).toBe(0x52); // R
    expect(buffer[1]).toBe(0x49); // I
    expect(buffer[2]).toBe(0x46); // F
    expect(buffer[3]).toBe(0x46); // F
    expect(buffer[8]).toBe(0x57); // W
    expect(buffer[9]).toBe(0x45); // E
    expect(buffer[10]).toBe(0x42); // B
    expect(buffer[11]).toBe(0x50); // P
  }, 30_000);

  test("rendering same candles twice produces ~identical sizes (within 5%)", async () => {
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: new Date(2026, 0, 1, i),
      open: 100 + Math.sin(i / 5) * 10,
      high: 100 + Math.sin(i / 5) * 10 + 5,
      low: 100 + Math.sin(i / 5) * 10 - 5,
      close: 100 + Math.sin((i + 1) / 5) * 10,
      volume: 100,
    }));

    const a = await renderer.render({
      candles,
      width: 800,
      height: 600,
      outputUri: `file://${join(outDir, "twice-a.png")}`,
    });
    const b = await renderer.render({
      candles,
      width: 800,
      height: 600,
      outputUri: `file://${join(outDir, "twice-b.png")}`,
    });

    // PNG output is deterministic in theory but timestamp metadata + AA can vary.
    expect(Math.abs(a.bytes - b.bytes) / Math.max(a.bytes, b.bytes)).toBeLessThan(0.05);
  }, 30_000);

  test("rendering empty candles array produces a valid (likely small) PNG without crashing", async () => {
    const result = await renderer.render({
      candles: [],
      width: 800,
      height: 600,
      outputUri: `file://${join(outDir, "empty.png")}`,
    });

    // Should still produce a valid PNG (chart with no data, just grid).
    expect(result.bytes).toBeGreaterThan(1000);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);
});
