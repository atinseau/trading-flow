import type { IndicatorSeriesContribution, RenderConfig } from "@domain/charts/types";
import type { Candle } from "@domain/schemas/Candle";
import type { IndicatorId } from "@domain/schemas/WatchesConfig";
import type { z } from "zod";

export type IndicatorTag =
  | "trend"
  | "volatility"
  | "momentum"
  | "volume"
  | "structure"
  | "liquidity";

export type ChartPaneKind = "price_overlay" | "secondary";
export type BreakdownAxis = "trigger" | "structure" | "volume" | "htf";
export type PreFilterCriterion =
  | "atr_ratio_min"
  | "volume_spike_min"
  | "rsi_extreme_distance"
  | "near_pivot";

export type ParamDescriptor =
  | {
      key: string;
      kind: "number";
      label: string;
      min: number;
      max: number;
      step?: number;
      help?: string;
    }
  | { key: string; kind: "enum"; label: string; options: ReadonlyArray<string>; help?: string };

export interface IndicatorPluginMetadata {
  readonly id: IndicatorId;
  readonly displayName: string;
  readonly tag: IndicatorTag;
  readonly shortDescription: string;
  readonly longDescription: string;
  readonly defaultParams?: Readonly<Record<string, unknown>>;
  readonly paramsDescriptor?: ReadonlyArray<ParamDescriptor>;
}

export interface IndicatorPlugin extends IndicatorPluginMetadata {
  // Compute
  computeScalars(candles: Candle[], params?: Record<string, unknown>): Record<string, unknown>;
  computeSeries(candles: Candle[], params?: Record<string, unknown>): IndicatorSeriesContribution;
  /**
   * Optional : produce the last `n` *scalar* values for each named series
   * the plugin exposes. Used by the prompt builder to inject a compact
   * historical view (e.g. `RSI last 10: 42.3 → 45.1 → … → 40.17`) so the
   * LLM can detect crossings/divergences without pixel-reading the chart.
   *
   * Plugins where time-series scalars make no sense (swings, fibonacci,
   * structure_levels, liquidity_pools — point-in-time anchors) leave it
   * undefined and PromptBuilder falls back to the spot scalar fragment.
   */
  computeScalarHistory?(
    candles: Candle[],
    params: Record<string, unknown> | undefined,
    n: number,
  ): Record<string, ReadonlyArray<number | null>>;

  // Schema
  scalarSchemaFragment(): z.ZodRawShape;

  // Chart rendering
  readonly chartPane: ChartPaneKind;
  readonly secondaryPaneStretch?: number;
  /**
   * Declarative render preferences consumed by the unified
   * `contributionRenderer`. Drives palette, pane, labels, stretch — the
   * plugin never invokes lightweight-charts directly.
   */
  readonly renderConfig: RenderConfig;

  // Prompt fragments
  detectorPromptFragment(
    scalars: Record<string, unknown>,
    params?: Record<string, unknown>,
    /** Optional per-series tail (computed by `computeScalarHistory`, length
     *  ≤ `watch.prompt_data.indicator_history_count`). Plugins that don't
     *  use the tail (point-in-time anchors) ignore the third argument. */
    history?: Record<string, ReadonlyArray<number | null>>,
  ): string | null;
  reviewerPromptFragment?(
    scalars: Record<string, unknown>,
    params?: Record<string, unknown>,
    history?: Record<string, ReadonlyArray<number | null>>,
  ): string | null;
  readonly contributedPatternTypes?: ReadonlyArray<string>;
  featuredFewShotExample?(): string | null;

  // Scoring & pre-filter
  readonly breakdownAxes?: ReadonlyArray<BreakdownAxis>;
  readonly preFilterCriterion?: PreFilterCriterion;

  readonly paramsSchema?: z.ZodObject<z.ZodRawShape>;
}

export type IndicatorClientMetadata = IndicatorPluginMetadata;
