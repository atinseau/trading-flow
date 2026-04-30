import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { buildConfidenceBreakdownSchema } from "@domain/schemas/ConfidenceBreakdown";

const KeyLevelsSchema = z.object({
  entry: z.number().nullable().optional(),
  invalidation: z.number(),
  target: z.number().nullable().optional(),
});

const PatternCategorySchema = z.enum(["event", "accumulation"]);

/**
 * Build the per-watch detector output schema. The LLM's response must
 * conform to this exact shape — extra fields are stripped silently
 * (consistent with Zod's default), but the BREAKDOWN/CLARITY shape
 * AND pattern_category/expected_maturation_ticks are now validated.
 *
 * Naked (no plugins): `clarity: number 0-100` instead of breakdown.
 * Equipped: `confidence_breakdown` with axes derived from active plugins
 * and HTF flag.
 */
export function buildDetectorOutputSchema(
  plugins: ReadonlyArray<IndicatorPlugin>,
  htfEnabled: boolean,
) {
  const breakdownSchema = buildConfidenceBreakdownSchema(plugins, htfEnabled);
  const isNaked = plugins.length === 0;

  const NewSetupBase = z.object({
    type: z.string(),
    direction: z.enum(["LONG", "SHORT"]),
    pattern_category: PatternCategorySchema,
    expected_maturation_ticks: z.number().int().min(1).max(6),
    key_levels: KeyLevelsSchema,
    initial_score: z.number().min(0).max(100),
    raw_observation: z.string(),
  });

  const NewSetupSchema = isNaked
    ? NewSetupBase.extend({ clarity: z.number().min(0).max(100) })
    : NewSetupBase.extend({ confidence_breakdown: breakdownSchema });

  return z.object({
    corroborations: z
      .array(
        z.object({
          setup_id: z.string(),
          evidence: z.array(z.string()),
          confidence_delta_suggested: z.number().min(0).max(20),
        }),
      )
      .default([]),
    new_setups: z.array(NewSetupSchema).default([]),
    ignore_reason: z.string().nullable(),
  });
}

export type DetectorOutput = z.infer<ReturnType<typeof buildDetectorOutputSchema>>;
