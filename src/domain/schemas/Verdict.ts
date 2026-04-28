import { z } from "zod";

export const ObservationSchema = z.object({
  kind: z.string().min(1),
  text: z.string().min(1),
  evidence: z.record(z.string(), z.unknown()).optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const VerdictSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("STRENGTHEN"),
    scoreDelta: z.number(),
    observations: z.array(ObservationSchema),
    reasoning: z.string(),
    invalidationLevelUpdate: z.number().nullable().optional(),
  }),
  z.object({
    type: z.literal("WEAKEN"),
    scoreDelta: z.number(),
    observations: z.array(ObservationSchema),
    reasoning: z.string(),
  }),
  z.object({
    type: z.literal("NEUTRAL"),
    observations: z.array(ObservationSchema),
  }),
  z.object({
    type: z.literal("INVALIDATE"),
    reason: z.string(),
  }),
]);
export type Verdict = z.infer<typeof VerdictSchema>;
