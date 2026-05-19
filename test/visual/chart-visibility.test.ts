import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { IndicatorRegistry, REGISTRY } from "@adapters/indicators/IndicatorRegistry";
import type { IndicatorSeriesContribution } from "@domain/charts/types";
import fixture from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";
import sharp from "sharp";

const candles = fixture.map((c) => ({
  timestamp: new Date(c.time * 1000),
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: c.volume,
}));

/**
 * Returns true if any column in the right strip (from `xFromRight` to
 * `xFromRight + scanWidth` physical pixels from the right edge) contains at
 * least 5 pixels matching either candle-up (#26a69a) or candle-down (#ef5350)
 * color.
 *
 * We scan a 40-px-wide strip rather than a single column because:
 *   - The renderer scales the 1280×720 logical viewport by the device pixel
 *     ratio (≈1.225), yielding a ~1568×882 physical image.
 *   - `computeRightOffset` returns offsets in candle units; the physical pixel
 *     mapping shifts slightly with candle density.
 *   - Scanning a strip keeps the assertion robust without over-specifying the
 *     exact pixel boundary.
 *
 * False positives are unlikely: the dark bg (#131722) and label gray (#d1d4dc)
 * are very different from both candle colors.
 */
async function rightColumnHasCandlePixels(
  buffer: Buffer,
  xFromRight = 80,
  scanWidth = 40,
): Promise<boolean> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });

  // Canonical candle colors. Tolerance is wide because sharp's WebP path
  // softens the colors slightly post-quality=85.
  const candleUp = [0x26, 0xa6, 0x9a];
  const candleDown = [0xef, 0x53, 0x50];
  const tolerance = 35;

  for (let dx = 0; dx < scanWidth; dx++) {
    const x = info.width - xFromRight - dx;
    if (x < 0) continue;

    let matches = 0;
    for (let y = 0; y < info.height; y++) {
      const idx = (y * info.width + x) * info.channels;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      if (
        (Math.abs(r - (candleUp[0] ?? 0)) < tolerance &&
          Math.abs(g - (candleUp[1] ?? 0)) < tolerance &&
          Math.abs(b - (candleUp[2] ?? 0)) < tolerance) ||
        (Math.abs(r - (candleDown[0] ?? 0)) < tolerance &&
          Math.abs(g - (candleDown[1] ?? 0)) < tolerance &&
          Math.abs(b - (candleDown[2] ?? 0)) < tolerance)
      ) {
        matches++;
        if (matches >= 5) return true;
      }
    }
  }
  return false;
}

const densities = [
  { name: "1 indicator", enabledIds: ["rsi"] },
  { name: "5 indicators", enabledIds: ["ema_stack", "rsi", "bollinger", "macd", "atr"] },
  { name: "10 indicators (all)", enabledIds: REGISTRY.map((p) => p.id as string) },
];

describe("chart visibility — last candles must never be masked by labels", () => {
  let renderer: PlaywrightChartRenderer;

  beforeAll(async () => {
    renderer = new PlaywrightChartRenderer(new IndicatorRegistry());
    await renderer.warmUp();
  }, 30_000);

  afterAll(async () => {
    await renderer.dispose();
  });

  for (const d of densities) {
    test(`${d.name}: rightmost column has candle pixels`, async () => {
      const series: Record<string, IndicatorSeriesContribution> = {};
      for (const id of d.enabledIds) {
        const plugin = REGISTRY.find((p) => p.id === id);
        if (!plugin) continue;
        // biome-ignore lint/suspicious/noExplicitAny: bypass strict Candle typing for fixture
        series[id] = plugin.computeSeries(candles as any);
      }

      const result = await renderer.render({
        candles,
        series,
        enabledIndicatorIds: d.enabledIds,
        width: 1280,
        height: 720,
        outputUri: `file:///tmp/chart-visibility-${d.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.webp`,
      });

      const visible = await rightColumnHasCandlePixels(result.content);
      expect(visible).toBe(true);
    }, 45_000);
  }
});
