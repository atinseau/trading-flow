/**
 * Dev CLI : batch-render chart images via the production PlaywrightChartRenderer
 * for several indicator combinations. Used to visually verify that the backend
 * (Playwright) path produces correct images for the LLM.
 *
 * Usage :
 *   bun run src/cli/dev-render-charts.ts \
 *     --source yahoo --symbol "EURUSD=X" --timeframe 1h --limit 200
 *
 * Output : .dev-render-charts/<n>_<combo>.webp + a Markdown index.
 *
 * No DB writes, no LLM calls, no Telegram. Pure rendering smoke test.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { IndicatorRegistry, REGISTRY } from "@adapters/indicators/IndicatorRegistry";
import { BinanceFetcher } from "@adapters/market-data/BinanceFetcher";
import { YahooFinanceFetcher } from "@adapters/market-data/YahooFinanceFetcher";
import type { IndicatorSeriesContribution } from "@domain/charts/types";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import { getLogger } from "@observability/logger";

const log = getLogger({ component: "dev-render-charts" });

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}
function argNum(name: string, fallback: number): number {
  const v = arg(name, "");
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SOURCE = arg("source", "yahoo");
const SYMBOL = arg("symbol", "EURUSD=X");
const TIMEFRAME = arg("timeframe", "1h");
const LIMIT = argNum("limit", 200);
const WIDTH = argNum("width", 1280);
const HEIGHT = argNum("height", 720);
const OUT_DIR = resolve(arg("out", ".dev-render-charts"));

/**
 * Combinations to render. Each entry produces one WebP. Keep the list small
 * enough that the whole batch completes in < 60s.
 */
type Combo = { name: string; ids: string[] };
const COMBOS: Combo[] = [
  { name: "00_naked", ids: [] },
  { name: "01_ema_stack", ids: ["ema_stack"] },
  { name: "02_rsi", ids: ["rsi"] },
  { name: "03_bollinger", ids: ["bollinger"] },
  { name: "04_macd", ids: ["macd"] },
  { name: "05_atr", ids: ["atr"] },
  { name: "06_vwap", ids: ["vwap"] },
  { name: "07_volume", ids: ["volume"] },
  { name: "08_swings_bos", ids: ["swings_bos"] },
  { name: "09_structure_levels", ids: ["structure_levels"] },
  { name: "10_liquidity_pools", ids: ["liquidity_pools"] },
  { name: "11_fibonacci", ids: ["fibonacci"] },
  { name: "12_ema_rsi", ids: ["ema_stack", "rsi"] },
  { name: "13_bollinger_macd", ids: ["bollinger", "macd"] },
  { name: "14_swings_structure_fib", ids: ["swings_bos", "structure_levels", "fibonacci"] },
  { name: "15_trio_classic", ids: ["ema_stack", "rsi", "volume"] },
  { name: "16_quad_momentum", ids: ["ema_stack", "rsi", "macd", "atr"] },
  {
    name: "17_all_overlays",
    ids: ["ema_stack", "vwap", "bollinger", "swings_bos", "structure_levels", "liquidity_pools", "fibonacci"],
  },
  {
    name: "18_all_secondaries",
    ids: ["rsi", "macd", "atr", "volume"],
  },
  {
    name: "19_full_stack",
    ids: REGISTRY.map((p) => p.id as string),
  },
];

function buildFetcher(source: string): MarketDataFetcher {
  if (source === "binance") return new BinanceFetcher();
  if (source === "yahoo") return new YahooFinanceFetcher();
  throw new Error(`Unknown source "${source}" — supported : binance, yahoo`);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  log.info(
    { source: SOURCE, symbol: SYMBOL, timeframe: TIMEFRAME, limit: LIMIT, out: OUT_DIR },
    "starting batch render",
  );

  // Fetch candles once — same input for every combo.
  const fetcher = buildFetcher(SOURCE);
  const candles = await fetcher.fetchOHLCV({
    asset: SYMBOL,
    timeframe: TIMEFRAME,
    limit: LIMIT,
  });
  if (candles.length === 0) {
    throw new Error(`no candles returned for ${SOURCE}/${SYMBOL} @ ${TIMEFRAME}`);
  }
  log.info({ count: candles.length }, "candles fetched");

  // Pre-compute every plugin's contribution once. Combos pick from the cache.
  const seriesByPluginId = new Map<string, IndicatorSeriesContribution>();
  for (const plugin of REGISTRY) {
    seriesByPluginId.set(plugin.id, plugin.computeSeries(candles));
  }

  const registry = new IndicatorRegistry();
  const renderer = new PlaywrightChartRenderer(registry, { poolSize: 1 });
  await renderer.warmUp();

  const indexEntries: Array<{ name: string; ids: string[]; file: string }> = [];
  try {
    for (const combo of COMBOS) {
      const series: Record<string, IndicatorSeriesContribution> = {};
      for (const id of combo.ids) {
        const s = seriesByPluginId.get(id);
        if (!s) throw new Error(`unknown plugin id in combo "${combo.name}" : ${id}`);
        series[id] = s;
      }
      const outFile = `${OUT_DIR}/${combo.name}.webp`;
      log.info(
        { combo: combo.name, ids: combo.ids.length, file: outFile },
        "rendering",
      );
      const result = await renderer.render({
        candles,
        series,
        enabledIndicatorIds: combo.ids,
        width: WIDTH,
        height: HEIGHT,
        outputUri: `file://${outFile}`,
      });
      indexEntries.push({ name: combo.name, ids: combo.ids, file: outFile });
      log.info({ combo: combo.name, bytes: result.bytes, sha256: result.sha256.slice(0, 8) }, "rendered");
    }
  } finally {
    await renderer.dispose();
  }

  // Write a Markdown index for quick visual review.
  const indexMd = [
    `# Backend chart-render smoke (${SOURCE} / ${SYMBOL} / ${TIMEFRAME}, ${candles.length} candles)`,
    "",
    `Rendered ${indexEntries.length} combinations via PlaywrightChartRenderer (same code path as production).`,
    "",
    ...indexEntries.flatMap((e) => [
      `## ${e.name}`,
      `Indicators : ${e.ids.length === 0 ? "_naked_" : e.ids.join(", ")}`,
      `![${e.name}](${e.name}.webp)`,
      "",
    ]),
  ].join("\n");
  const indexPath = `${OUT_DIR}/index.md`;
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, indexMd);
  log.info({ index: indexPath }, "done");
}

main().catch((e) => {
  log.error({ err: (e as Error).message }, "failed");
  process.exit(1);
});
