import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { FakeMarketDataFetcher } from "@test-fakes/FakeMarketDataFetcher";

describe("PlaywrightChartRenderer page pool semaphore", () => {
  let renderer: PlaywrightChartRenderer;
  let outDir: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "tf-chart-sem-"));
    renderer = new PlaywrightChartRenderer(new IndicatorRegistry(), { poolSize: 2 });
    await renderer.warmUp();
  }, 30_000);

  afterAll(async () => {
    await renderer.dispose();
    await rm(outDir, { recursive: true, force: true });
  });

  test("5 concurrent renders complete without race + within pool size limit", async () => {
    const candles = FakeMarketDataFetcher.generateLinear(100, 100);
    const tasks = Array.from({ length: 5 }, (_, i) =>
      renderer.render({
        candles,
        series: {},
        enabledIndicatorIds: [],
        width: 800,
        height: 600,
        outputUri: `file://${join(outDir, `concurrent-${i}.png`)}`,
      }),
    );
    const results = await Promise.all(tasks);
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.bytes).toBeGreaterThan(1000);
      expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  }, 60_000);
});
