import type { Candle } from "@domain/schemas/Candle";
import type { IndicatorId } from "@domain/schemas/WatchesConfig";
import type { z } from "zod";
import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";

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

export interface IndicatorPluginMetadata {
  readonly id: IndicatorId;
  readonly displayName: string;
  readonly tag: IndicatorTag;
  readonly shortDescription: string;
  readonly longDescription: string;
}

export interface IndicatorPlugin extends IndicatorPluginMetadata {
  // Compute
  computeScalars(candles: Candle[]): Record<string, unknown>;
  computeSeries(candles: Candle[]): IndicatorSeriesContribution;

  // Schema
  scalarSchemaFragment(): z.ZodRawShape;

  // Chart rendering
  readonly chartScript: string;
  readonly chartPane: ChartPaneKind;
  readonly secondaryPaneStretch?: number;

  // Prompt fragments
  detectorPromptFragment(scalars: Record<string, unknown>): string | null;
  reviewerPromptFragment?(scalars: Record<string, unknown>): string | null;
  readonly contributedPatternTypes?: ReadonlyArray<string>;
  featuredFewShotExample?(): string | null;

  // Scoring & pre-filter
  readonly breakdownAxes?: ReadonlyArray<BreakdownAxis>;
  readonly preFilterCriterion?: PreFilterCriterion;
}

export type IndicatorClientMetadata = IndicatorPluginMetadata;
