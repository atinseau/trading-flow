// src/domain/services/PromptBuilder.ts

import type { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { type LoadedPrompt, loadPrompt } from "@adapters/prompts/loadPrompt";
import type { Candle } from "@domain/schemas/Candle";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { FewShotEngine } from "@domain/services/FewShotEngine";
import { formatRecentOhlcv } from "@domain/services/formatRecentOhlcv";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

/** Defensive fallback when a caller (older tests, transient migrations)
 *  passes a watch without `prompt_data`. Matches the Zod `.prefault({})`
 *  output exactly — keeps behavior identical to a fresh watch. */
const DEFAULT_PROMPT_DATA: WatchConfig["prompt_data"] = {
  recent_ohlcv_count: 50,
  indicator_history_count: 10,
  include_recent_in_finalizer: true,
  decimals: null,
  timestamp_format: "time",
  include_volume: true,
};

export class PromptBuilder {
  private detector: LoadedPrompt | null = null;
  private reviewer: LoadedPrompt | null = null;

  constructor(
    private registry: IndicatorRegistry,
    private fewShot: FewShotEngine,
  ) {}

  async warmUp(): Promise<void> {
    if (!this.detector) this.detector = await loadPrompt("detector");
    if (!this.reviewer) this.reviewer = await loadPrompt("reviewer");
  }

  get detectorVersion(): string {
    return this.detector?.version ?? "unknown";
  }

  get reviewerVersion(): string {
    return this.reviewer?.version ?? "unknown";
  }

  get reviewerSystemPrompt(): string {
    return this.reviewer?.systemPrompt ?? "";
  }

  get detectorSystemPrompt(): string {
    return this.detector?.systemPrompt ?? "";
  }

  async buildDetectorPrompt(args: {
    asset: string;
    timeframe: string;
    tickAt: Date;
    scalars: Record<string, unknown>;
    activeLessons: Array<{ title: string; body: string }>;
    aliveSetups: Array<unknown>;
    htf?: { dailyTrend: string };
    indicatorsMatrix: WatchConfig["indicators"];
    candles: ReadonlyArray<Candle>;
    promptData?: WatchConfig["prompt_data"];
  }): Promise<string> {
    if (!this.detector) await this.warmUp();
    const plugins = this.registry.resolveActive(args.indicatorsMatrix);
    const isVolumeActive = plugins.some((p) => p.id === "volume");
    const promptData = args.promptData ?? DEFAULT_PROMPT_DATA;
    const histN = promptData.indicator_history_count;
    const indicatorFragments = plugins
      .map((p) => {
        const params = args.indicatorsMatrix[p.id]?.params as
          | Record<string, unknown>
          | undefined;
        const history =
          histN > 0 && p.computeScalarHistory
            ? p.computeScalarHistory([...args.candles], params, histN)
            : undefined;
        return p.detectorPromptFragment(args.scalars, params, history);
      })
      .filter((s): s is string => s != null)
      .join("\n");
    const classificationBlock = composeClassificationBlock(plugins, !!args.htf);
    const fewShotExamples = this.fewShot.compose(plugins);
    const outputFormatTable = composeOutputFormatTable(plugins, !!args.htf);
    const recentOhlcvTable = formatRecentOhlcv(args.candles, {
      count: promptData.recent_ohlcv_count,
      decimals: promptData.decimals,
      timestampFormat: promptData.timestamp_format,
      includeVolume: promptData.include_volume,
    });
    return this.detector!.render({
      asset: args.asset,
      timeframe: args.timeframe,
      tickAt: args.tickAt.toISOString(),
      activeLessons: args.activeLessons,
      aliveSetups: args.aliveSetups,
      htf: args.htf,
      hasIndicators: plugins.length > 0,
      isVolumeActive,
      indicatorFragments,
      classificationBlock,
      fewShotExamples,
      outputFormatTable,
      recentOhlcvTable,
      hasRecentOhlcv: recentOhlcvTable.length > 0,
      recentOhlcvCount: promptData.recent_ohlcv_count,
    });
  }

  async buildReviewerPrompt(args: {
    setup: unknown;
    history: unknown[];
    fresh: { lastClose: number; scalars: Record<string, unknown>; tickAt: Date };
    activeLessons: Array<{ title: string; body: string }>;
    htf?: unknown;
    funding?: unknown;
    indicatorsMatrix: WatchConfig["indicators"];
    candles: ReadonlyArray<Candle>;
    promptData?: WatchConfig["prompt_data"];
  }): Promise<string> {
    if (!this.reviewer) await this.warmUp();
    const plugins = this.registry.resolveActive(args.indicatorsMatrix);
    const promptData = args.promptData ?? DEFAULT_PROMPT_DATA;
    const histN = promptData.indicator_history_count;
    const reviewerIndicatorFragments = plugins
      .map((p) => {
        const params = args.indicatorsMatrix[p.id]?.params as
          | Record<string, unknown>
          | undefined;
        const history =
          histN > 0 && p.computeScalarHistory
            ? p.computeScalarHistory([...args.candles], params, histN)
            : undefined;
        return p.reviewerPromptFragment?.(args.fresh.scalars, params, history);
      })
      .filter((s): s is string => typeof s === "string")
      .map((s) => `- ${s}`)
      .join("\n");
    const recentOhlcvTable = formatRecentOhlcv(args.candles, {
      count: promptData.recent_ohlcv_count,
      decimals: promptData.decimals,
      timestampFormat: promptData.timestamp_format,
      includeVolume: promptData.include_volume,
    });
    return this.reviewer!.render({
      setup: args.setup,
      history: args.history,
      tick: { tickAt: args.fresh.tickAt.toISOString() },
      fresh: { lastClose: args.fresh.lastClose },
      activeLessons: args.activeLessons,
      htf: args.htf,
      funding: args.funding,
      hasIndicators: plugins.length > 0,
      reviewerIndicatorFragments,
      recentOhlcvTable,
      hasRecentOhlcv: recentOhlcvTable.length > 0,
      recentOhlcvCount: promptData.recent_ohlcv_count,
    });
  }
}

function composeClassificationBlock(
  plugins: ReadonlyArray<IndicatorPlugin>,
  htfEnabled: boolean,
): string {
  if (plugins.length === 0) {
    return [
      "Every proposed setup MUST declare:",
      "",
      "- **`pattern_category`**: `event` (single trigger) or `accumulation` (multi-touch).",
      "- **`expected_maturation_ticks`** (1-6): how many reviewer ticks before finalizer-ready.",
      "- **`clarity`** (0-100): how visually clear is the pattern on the chart, judged from the image alone.",
    ].join("\n");
  }
  const axes = new Set<string>(["trigger"]);
  for (const p of plugins) for (const a of p.breakdownAxes ?? []) axes.add(a);
  if (htfEnabled) axes.add("htf");
  const axesList = [...axes];
  return [
    "Every proposed setup MUST declare:",
    "",
    "- **`pattern_category`**: `event` or `accumulation`.",
    "- **`expected_maturation_ticks`** (1-6): see system prompt.",
    "- **`confidence_breakdown`**: each axis 0-25; sum equals `initial_score` (±2).",
    `  Axes for this watch: ${axesList.map((a) => `"${a}"`).join(", ")}.`,
  ].join("\n");
}

function composeOutputFormatTable(
  plugins: ReadonlyArray<IndicatorPlugin>,
  _htfEnabled: boolean,
): string {
  const breakdownRow =
    plugins.length === 0
      ? '| `new_setups[i]."clarity"` | number 0-100 | Visual pattern clarity |'
      : "| `new_setups[i].confidence_breakdown` | object | Per-axis 0-25 scores; sum ≈ initial_score |";
  return [
    "Respond with a strict JSON object. All fields below REQUIRED.",
    "",
    "| Field | Type | Description |",
    "|-------|------|-------------|",
    "| `corroborations` | array | Alive setups reinforced this tick |",
    "| `corroborations[i].setup_id` | string | ID of an alive setup |",
    "| `corroborations[i].evidence` | array<string> | Quantified observations |",
    "| `corroborations[i].confidence_delta_suggested` | number -20..20 | Signed delta — see calibration table |",
    "| `new_setups` | array | New setups proposed |",
    "| `new_setups[i].type` | string | Free-form label |",
    '| `new_setups[i].direction` | string | "LONG" / "SHORT" |',
    '| `new_setups[i].pattern_category` | string | "event" / "accumulation" |',
    "| `new_setups[i].expected_maturation_ticks` | int 1-6 | Reviewer ticks expected |",
    breakdownRow,
    "| `new_setups[i].key_levels.entry` | number optional | Entry |",
    "| `new_setups[i].key_levels.invalidation` | number REQUIRED | Invalidation |",
    "| `new_setups[i].key_levels.target` | number optional | Target |",
    "| `new_setups[i].initial_score` | number 0..100 | Initial score |",
    "| `new_setups[i].raw_observation` | string | Concise explanation |",
    "| `ignore_reason` | string or null | If nothing to signal |",
  ].join("\n");
}
