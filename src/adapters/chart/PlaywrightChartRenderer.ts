import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChartRenderer, ChartRenderResult } from "@domain/ports/ChartRenderer";
import type { Candle } from "@domain/schemas/Candle";
import { type Browser, chromium, type Page } from "playwright";
import sharp from "sharp";

// Claude Vision auto-resizes images to 1568px max on the long side before
// tokenization (`tokens = (W × H) / 750`). Rendering above this is wasted
// bytes; rendering at exactly this cap matches Claude's billing without
// degrading detail. Capping is the only way to *reduce* image tokens; format
// (WebP vs PNG) only affects bytes/transfer, not tokens.
const MAX_LLM_DIMENSION = 1568;

export class PlaywrightChartRenderer implements ChartRenderer {
  private browser: Browser | null = null;
  private pagePool: Page[] = [];
  private templateHtml: string | null = null;
  private pagesInUse = 0;
  private pagePromiseQueue: Array<(page: Page) => void> = [];

  constructor(private opts: { poolSize?: number; templatePath?: string } = {}) {}

  async warmUp(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({ headless: true });
    const size = this.opts.poolSize ?? 2;
    const tplPath =
      this.opts.templatePath ??
      join(dirname(fileURLToPath(import.meta.url)), "chart-template.html");
    const rawTemplate = await Bun.file(tplPath).text();
    // Inline the lightweight-charts bundle to remove the CDN dependency — eliminates
    // network flake when chromium fetches the script during setContent.
    const pkgJsonPath = require.resolve("lightweight-charts/package.json");
    const libPath = join(
      dirname(pkgJsonPath),
      "dist",
      "lightweight-charts.standalone.production.js",
    );
    const libSource = await Bun.file(libPath).text();
    this.templateHtml = rawTemplate.replace(
      "<!-- {{LIGHTWEIGHT_CHARTS_INLINE}} - replaced by PlaywrightChartRenderer at warmUp -->",
      `<script>${libSource}</script>`,
    );
    for (let i = 0; i < size; i++) {
      const page = await this.browser.newPage({
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      await page.setContent(this.templateHtml);
      this.pagePool.push(page);
    }
  }

  async render(args: {
    candles: Candle[];
    indicators?: import("@domain/ports/IndicatorCalculator").IndicatorSeries;
    width: number;
    height: number;
    outputUri: string;
  }): Promise<ChartRenderResult> {
    if (!this.browser) await this.warmUp();
    const page = await this.acquirePage();
    try {
      await page.setViewportSize({ width: args.width, height: args.height });
      await page.setContent(this.templateHtml as string);
      const payload = {
        candles: args.candles.map((c) => ({
          time: Math.floor(c.timestamp.getTime() / 1000),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })),
        indicators: args.indicators ?? null,
      };
      await page.evaluate((data) => {
        (window as unknown as { __renderCandles: (c: unknown) => void }).__renderCandles(data);
      }, payload);
      await page.waitForFunction(
        () => (window as unknown as { __chartReady?: boolean }).__chartReady === true,
        { timeout: 5000 },
      );
      const png = await page.screenshot({ type: "png", omitBackground: false });
      // Resize-to-cap + WebP encode in one pipeline. `fit: "inside"` preserves
      // aspect ratio; `withoutEnlargement` no-ops if the source is already
      // smaller than the cap. WebP @ q85 is visually indistinguishable from
      // PNG for line/candle charts and ~5× smaller bytes.
      const buffer = await sharp(png)
        .resize(MAX_LLM_DIMENSION, MAX_LLM_DIMENSION, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 85 })
        .toBuffer();
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      // Swap the .png suffix from the caller's outputUri to .webp so the
      // file extension matches the bytes.
      const webpUri = args.outputUri.replace(/\.png$/i, ".webp");
      const path = webpUri.replace(/^file:\/\//, "");
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, buffer);
      return {
        uri: webpUri,
        sha256,
        bytes: buffer.length,
        mimeType: "image/webp",
        content: buffer,
      };
    } finally {
      this.releasePage(page);
    }
  }

  async dispose(): Promise<void> {
    // Drop any pending waiters; callers awaiting will hang, which is acceptable
    // at shutdown (process exit cleans them up).
    this.pagePromiseQueue = [];
    for (const p of this.pagePool) await p.close().catch(() => {});
    this.pagePool = [];
    this.pagesInUse = 0;
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }

  private async acquirePage(): Promise<Page> {
    const poolSize = this.opts.poolSize ?? 2;

    if (this.pagesInUse >= poolSize) {
      // At capacity — wait for a release (FIFO).
      return new Promise<Page>((resolve) => {
        this.pagePromiseQueue.push(resolve);
      });
    }

    this.pagesInUse++;
    const fromPool = this.pagePool.pop();
    if (fromPool) return fromPool;
    if (!this.browser) throw new Error("Browser not initialized");
    return this.browser.newPage({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
  }

  private releasePage(page: Page): void {
    // Hand off to a waiter if any — pagesInUse stays the same (transferred ownership).
    const waiter = this.pagePromiseQueue.shift();
    if (waiter) {
      waiter(page);
      return;
    }
    // Otherwise: return to pool and decrement counter.
    this.pagesInUse--;
    this.pagePool.push(page);
  }
}
