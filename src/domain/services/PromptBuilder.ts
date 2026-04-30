// src/domain/services/PromptBuilder.ts
import { loadPrompt, type LoadedPrompt } from "@adapters/prompts/loadPrompt";
import type { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import type { FewShotEngine } from "@domain/services/FewShotEngine";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";

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

  async buildDetectorPrompt(args: {
    asset: string;
    timeframe: string;
    tickAt: Date;
    scalars: Record<string, unknown>;
    activeLessons: Array<{ title: string; body: string }>;
    aliveSetups: Array<unknown>;
    htf?: { dailyTrend: string };
    indicatorsMatrix: WatchConfig["indicators"];
  }): Promise<string> {
    if (!this.detector) await this.warmUp();
    const plugins = this.registry.resolveActive(args.indicatorsMatrix);
    const isVolumeActive = plugins.some((p) => p.id === "volume");
    const indicatorFragments = plugins
      .map((p) => p.detectorPromptFragment(args.scalars))
      .filter((s): s is string => s != null)
      .join("\n");
    const classificationBlock = composeClassificationBlock(plugins, !!args.htf);
    const fewShotExamples = this.fewShot.compose(plugins);
    const outputFormatTable = composeOutputFormatTable(plugins, !!args.htf);
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
  }): Promise<string> {
    if (!this.reviewer) await this.warmUp();
    const plugins = this.registry.resolveActive(args.indicatorsMatrix);
    const reviewerIndicatorFragments = plugins
      .map((p) => p.reviewerPromptFragment?.(args.fresh.scalars))
      .filter((s): s is string => typeof s === "string")
      .map((s) => `- ${s}`)
      .join("\n");
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
  const breakdownRow = plugins.length === 0
    ? "| `new_setups[i].\"clarity\"` | number 0-100 | Visual pattern clarity |"
    : "| `new_setups[i].confidence_breakdown` | object | Per-axis 0-25 scores; sum ≈ initial_score |";
  return [
    "Respond with a strict JSON object. All fields below REQUIRED.",
    "",
    "| Field | Type | Description |",
    "|-------|------|-------------|",
    "| `corroborations` | array | Alive setups reinforced this tick |",
    "| `corroborations[i].setup_id` | string | ID of an alive setup |",
    "| `corroborations[i].evidence` | array<string> | Quantified observations |",
    "| `corroborations[i].confidence_delta_suggested` | number 0..20 | Delta |",
    "| `new_setups` | array | New setups proposed |",
    "| `new_setups[i].type` | string | Free-form label |",
    "| `new_setups[i].direction` | string | \"LONG\" / \"SHORT\" |",
    "| `new_setups[i].pattern_category` | string | \"event\" / \"accumulation\" |",
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
