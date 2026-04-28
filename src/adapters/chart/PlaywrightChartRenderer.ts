import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChartRenderer, ChartRenderResult } from "@domain/ports/ChartRenderer";
import type { Candle } from "@domain/schemas/Candle";
import { type Browser, chromium, type Page } from "playwright";

export class PlaywrightChartRenderer implements ChartRenderer {
  private browser: Browser | null = null;
  private pagePool: Page[] = [];
  private templateHtml: string | null = null;

  constructor(private opts: { poolSize?: number; templatePath?: string } = {}) {}

  async warmUp(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({ headless: true });
    const size = this.opts.poolSize ?? 2;
    const tplPath =
      this.opts.templatePath ??
      join(dirname(fileURLToPath(import.meta.url)), "chart-template.html");
    this.templateHtml = await readFile(tplPath, "utf8");
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
      await writeFile(path, buffer);
      return { uri: args.outputUri, sha256, bytes: buffer.length, mimeType: "image/png" };
    } finally {
      this.releasePage(page);
    }
  }

  async dispose(): Promise<void> {
    for (const p of this.pagePool) await p.close().catch(() => {});
    this.pagePool = [];
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }

  private async acquirePage(): Promise<Page> {
    const p = this.pagePool.pop();
    if (p) return p;
    if (!this.browser) throw new Error("Browser not initialized");
    return this.browser.newPage({ viewport: { width: 1280, height: 720 } });
  }

  private releasePage(page: Page): void {
    if (this.pagePool.length < (this.opts.poolSize ?? 2)) {
      this.pagePool.push(page);
    } else {
      page.close().catch(() => {});
    }
  }
}
