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
  ): string | null;
  reviewerPromptFragment?(
    scalars: Record<string, unknown>,
    params?: Record<string, unknown>,
  ): string | null;
  readonly contributedPatternTypes?: ReadonlyArray<string>;
  featuredFewShotExample?(): string | null;

  // Scoring & pre-filter
  readonly breakdownAxes?: ReadonlyArray<BreakdownAxis>;
  readonly preFilterCriterion?: PreFilterCriterion;

  readonly paramsSchema?: z.ZodObject<z.ZodRawShape>;
}

export type IndicatorClientMetadata = IndicatorPluginMetadata;
