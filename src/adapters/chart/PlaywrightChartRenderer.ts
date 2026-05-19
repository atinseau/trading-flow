import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";
import type { RenderConfig } from "@domain/charts/types";
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

  constructor(
    private registry: IndicatorRegistry,
    private opts: { poolSize?: number; templatePath?: string } = {},
  ) {}

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

    // Build the transpiled framework bundle (5 TS source files → one IIFE).
    const frameworkBundle = await this.buildFrameworkBundle();

    this.templateHtml = rawTemplate
      .replace("<!-- {{LIGHTWEIGHT_CHARTS_INLINE}} -->", `<script>${libSource}</script>`)
      .replace("<!-- {{FRAMEWORK_BUNDLE}} -->", `<script>${frameworkBundle}</script>`);

    for (let i = 0; i < size; i++) {
      const page = await this.browser.newPage({
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
        deviceScaleFactor: 2, // higher pixel density → sharper screenshots after resize cap
      });
      await page.setContent(this.templateHtml);
      this.pagePool.push(page);
    }
  }

  async render(args: {
    candles: Candle[];
    series: Record<string, IndicatorSeriesContribution>;
    enabledIndicatorIds: ReadonlyArray<string>;
    width: number;
    height: number;
    outputUri: string;
    /** "llm" (default) caps the long side at MAX_LLM_DIMENSION to match
     *  Claude Vision's auto-resize and avoid wasted image tokens.
     *  "highres" skips the resize — use only for dev/visual debugging
     *  where the consumer is a human, not the LLM. */
    outputMode?: "llm" | "highres";
  }): Promise<ChartRenderResult> {
    if (!this.browser) await this.warmUp();
    const page = await this.acquirePage();
    try {
      await page.setViewportSize({ width: args.width, height: args.height });
      await page.setContent(this.templateHtml as string);

      // Build the self-contained indicators array for the new payload shape.
      const indicators = args.enabledIndicatorIds
        .map((id) => {
          const plugin = this.registry.byId(id as never);
          if (!plugin) return null;
          const contribution = args.series[id];
          if (!contribution) return null;
          return { id, contribution, renderConfig: plugin.renderConfig };
        })
        .filter(
          (
            i,
          ): i is {
            id: string;
            contribution: IndicatorSeriesContribution;
            renderConfig: RenderConfig;
          } => i !== null,
        );

      const payload = {
        candles: args.candles.map((c) => ({
          time: Math.floor(c.timestamp.getTime() / 1000),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })),
        indicators,
      };

      await page.evaluate((data) => {
        (
          window as unknown as { __tradingFlowChart: { render: (p: unknown) => void } }
        ).__tradingFlowChart.render(data);
      }, payload);

      await page.waitForFunction(
        () => (window as unknown as { __chartReady?: boolean }).__chartReady === true,
        { timeout: 5000 },
      );
      const png = await page.screenshot({ type: "png", omitBackground: false });
      const pipeline = sharp(png);
      if ((args.outputMode ?? "llm") === "llm") {
        pipeline.resize(MAX_LLM_DIMENSION, MAX_LLM_DIMENSION, {
          fit: "inside",
          withoutEnlargement: true,
        });
      }
      const buffer = await pipeline.webp({ quality: 85 }).toBuffer();
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      // Swap the .png suffix from the caller's outputUri to .webp so the
      // stored artifact matches the actual format.
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

  /**
   * Transpiles the 5 framework TS source files via Bun.Transpiler and wraps
   * them in a single IIFE that exposes `window.__tradingFlowChart.render(payload)`.
   *
   * The page has no module loader, so we flatten all imports:
   * - ES `import` statements are stripped (they're either type-only or resolved
   *   via the IIFE scope from globalThis.LightweightCharts).
   * - `export` keywords are stripped (all symbols live in the IIFE scope).
   */
  private async buildFrameworkBundle(): Promise<string> {
    const modulesDir = dirname(fileURLToPath(import.meta.url));
    const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
    const filenames = [
      "countAxisLabels.ts",
      "bandsPrimitive.ts",
      "paneAllocator.ts",
      "chartBootstrap.ts",
      "contributionRenderer.ts",
    ];
    const sources = await Promise.all(filenames.map((f) => Bun.file(join(modulesDir, f)).text()));
    const transpiled = sources
      .map((s) => transpiler.transformSync(s))
      // Strip ES imports — lightweight-charts types are erased, sibling
      // imports are replaced by the flattened IIFE scope.
      .map((s) => s.replace(/^import\s.*;$/gm, ""))
      // Strip `export ` keyword — all symbols share the IIFE scope.
      .map((s) => s.replace(/^export /gm, ""))
      .join("\n");

    return `
(() => {
  // Resolve lightweight-charts globals; readLC() in chartBootstrap/contributionRenderer
  // picks them up from globalThis.LightweightCharts at call time.
  const LC = globalThis.LightweightCharts;
  const { CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } = LC;

  ${transpiled}

  window.__tradingFlowChart = {
    render(payload) {
      const container = document.getElementById("chart");
      const { chart, candleSeries } = createTradingViewChart(container, {
        width: window.innerWidth,
        height: window.innerHeight,
        naked: payload.indicators.length === 0,
      });
      candleSeries.setData(payload.candles);

      const ind = payload.indicators.map((i) => ({
        id: i.id,
        pane: i.renderConfig.pane,
        secondaryPaneStretch: i.renderConfig.secondaryPaneStretch,
      }));
      const visibility = Object.fromEntries(ind.map((i) => [i.id, true]));
      const alloc = allocatePanes(ind, visibility);

      const markerBucket = [];
      const candleTimes = payload.candles.map((c) => c.time);

      for (const i of payload.indicators) {
        const paneIndex = alloc.assignments[i.id];
        if (paneIndex === undefined) continue;
        applyContribution(chart, i.contribution, {
          id: i.id,
          renderConfig: i.renderConfig,
          paneIndex,
          candleTimes,
          mainSeries: candleSeries,
          markerBucket,
        });
      }

      for (const [idx, stretch] of alloc.stretches) {
        chart.panes()[idx]?.setStretchFactor(stretch);
      }

      let priceOverlayLineCount = 0;
      let maxLabelTextLength = 0;
      for (const i of payload.indicators) {
        if (i.renderConfig.pane !== "price_overlay") continue;
        priceOverlayLineCount += countAxisLabels(i.contribution);
        maxLabelTextLength = Math.max(
          maxLabelTextLength,
          maxAxisLabelLength(i.id, i.contribution, i.renderConfig),
        );
      }
      // window.innerWidth is stable; chart.timeScale().width() can be 0 at
      // this point — lightweight-charts hasn't laid out yet (series added,
      // no fitContent / setVisibleLogicalRange ran). The ~60 px the
      // price-scale Y column steals is absorbed by the chip-width overhead.
      const rightPad = computeRightPadCandles(
        { density: { priceOverlayLineCount, priceLineCount: 0 }, maxLabelTextLength },
        { widthPx: window.innerWidth, candleCount: payload.candles.length },
      );
      applyChartRange(chart, {
        candleCount: payload.candles.length,
        leftPad: 3,
        rightPad,
      });

      if (markerBucket.length > 0 && createSeriesMarkers) {
        createSeriesMarkers(candleSeries).setMarkers(markerBucket);
      }

      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__chartReady = true;
      }));
    },
  };
})();
`;
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
    return this.browser.newPage({
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      deviceScaleFactor: 2, // higher pixel density → sharper screenshots after resize cap
    });
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
