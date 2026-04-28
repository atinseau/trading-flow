import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { FakeMarketDataFetcher } from "@test-fakes/FakeMarketDataFetcher";

describe("PlaywrightChartRenderer", () => {
  let renderer: PlaywrightChartRenderer;
  let outDir: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "tf-chart-"));
    renderer = new PlaywrightChartRenderer({ poolSize: 1 });
    await renderer.warmUp();
  }, 30_000);

  afterAll(async () => {
    await renderer.dispose();
    await rm(outDir, { recursive: true, force: true });
  });

  test("renders 100 candles to PNG with valid sha256", async () => {
    const candles = FakeMarketDataFetcher.generateLinear(100, 100);
    const out = `file://${join(outDir, "test.png")}`;
    const result = await renderer.render({ candles, width: 1280, height: 720, outputUri: out });
    expect(result.mimeType).toBe("image/png");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bytes).toBeGreaterThan(1000);
    expect(Bun.file(out.replace(/^file:\/\//, "")).size).toBe(result.bytes);
  }, 30_000);

  test("rendering twice produces consistent output sizes", async () => {
    const candles = FakeMarketDataFetcher.generateLinear(50, 200);
    const a = await renderer.render({
      candles,
      width: 800,
      height: 600,
      outputUri: `file://${join(outDir, "a.png")}`,
    });
    const b = await renderer.render({
      candles,
      width: 800,
      height: 600,
      outputUri: `file://${join(outDir, "b.png")}`,
    });
    expect(Math.abs(a.bytes - b.bytes)).toBeLessThan(a.bytes * 0.1);
  }, 30_000);
});
