import { ObservationSchema } from "@domain/schemas/Verdict";
import { z } from "zod";

/**
 * Optional tool-call request the reviewer can emit on its first LLM call. The
 * activity reads this, renders any requested artifact (e.g. an HTF chart),
 * and replays the call with the artifact attached. The final stored verdict
 * is stripped of this field — it lives only on the wire between LLM rounds.
 */
export const ReviewerRequestAdditionalSchema = z.object({
  htfChart: z.boolean().optional(),
  reason: z.string().optional(),
});
export type ReviewerRequestAdditional = z.infer<typeof ReviewerRequestAdditionalSchema>;

/**
 * Reviewer-on-the-wire schema: the verdict plus an optional
 * `request_additional` block. Defined as a non-discriminated `z.object` (not
 * a union of literals) because the LLM may emit `request_additional` *with
 * any* verdict type — and Zod discriminated unions can't share an extra
 * field across variants without verbose duplication.
 *
 * Defaults are applied so a wire-valid response always passes the strict
 * `VerdictSchema.parse` downstream — fixes the wedge bug where an LLM
 * STRENGTHEN/WEAKEN response without explicit `observations: []` would
 * cross the wire boundary then crash strict parsing.
 */
export const ReviewerLlmOutputSchema = z
  .object({
    type: z.enum(["STRENGTHEN", "WEAKEN", "NEUTRAL", "INVALIDATE"]),
    scoreDelta: z.number().optional(),
    // Default to [] so a STRENGTHEN/WEAKEN missing observations on the wire
    // still strict-parses through VerdictSchema downstream.
    observations: z.array(ObservationSchema).default([]),
    reasoning: z.string().optional(),
    reason: z.string().optional(),
    invalidationLevelUpdate: z.number().nullable().optional(),
    request_additional: ReviewerRequestAdditionalSchema.optional(),
  })
  // Cross-field validation: required fields per discriminant value.
  .refine(
    (v) => v.type !== "STRENGTHEN" || (v.scoreDelta !== undefined && v.reasoning !== undefined),
    { message: "STRENGTHEN requires scoreDelta + reasoning" },
  )
  .refine((v) => v.type !== "WEAKEN" || (v.scoreDelta !== undefined && v.reasoning !== undefined), {
    message: "WEAKEN requires scoreDelta + reasoning",
  })
  .refine((v) => v.type !== "INVALIDATE" || v.reason !== undefined, {
    message: "INVALIDATE requires reason",
  });

export type ReviewerLlmOutput = z.infer<typeof ReviewerLlmOutputSchema>;
