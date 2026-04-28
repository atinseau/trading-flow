import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChartRenderer, ChartRenderResult } from "@domain/ports/ChartRenderer";
import type { Candle } from "@domain/schemas/Candle";
import { type Browser, chromium, type Page } from "playwright";

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
    this.templateHtml = await Bun.file(tplPath).text();
    for (let i = 0; i < size; i++) {
      const page = await this.browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.setContent(this.templateHtml);
      this.pagePool.push(page);
    }
  }

  async render(args: {
    candles: Candle[];
    width: number;
    height: number;
    outputUri: string;
  }): Promise<ChartRenderResult> {
    if (!this.browser) await this.warmUp();
    const page = await this.acquirePage();
    try {
      await page.setViewportSize({ width: args.width, height: args.height });
      await page.setContent(this.templateHtml as string);
      await page.evaluate(
        (data) => {
          (window as unknown as { __renderCandles: (c: unknown) => void }).__renderCandles(data);
        },
        args.candles.map((c) => ({
          time: Math.floor(c.timestamp.getTime() / 1000),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
      await page.waitForFunction(
        () => (window as unknown as { __chartReady?: boolean }).__chartReady === true,
        { timeout: 5000 },
      );
      const buffer = await page.screenshot({ type: "png", omitBackground: false });
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const path = args.outputUri.replace(/^file:\/\//, "");
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, buffer);
      return {
        uri: args.outputUri,
        sha256,
        bytes: buffer.length,
        mimeType: "image/png",
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
    return this.browser.newPage({ viewport: { width: 1280, height: 720 } });
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
