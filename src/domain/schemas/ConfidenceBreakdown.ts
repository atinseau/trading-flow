import { z } from "zod";
import type { BreakdownAxis, IndicatorPlugin } from "@domain/services/IndicatorPlugin";

export type AdaptiveConfidenceBreakdown =
  | { clarity: number }
  | Partial<Record<BreakdownAxis, number>>;

export function buildConfidenceBreakdownSchema(
  plugins: ReadonlyArray<IndicatorPlugin>,
  htfEnabled: boolean,
): z.ZodObject<z.ZodRawShape> {
  if (plugins.length === 0) {
    return z.object({ clarity: z.number().min(0).max(100) }).strict();
  }
  const axes = new Set<BreakdownAxis>();
  axes.add("trigger");
  for (const p of plugins) for (const a of p.breakdownAxes ?? []) axes.add(a);
  if (htfEnabled) axes.add("htf");
  const shape: z.ZodRawShape = Object.fromEntries(
    [...axes].map((a) => [a, z.number().min(0).max(25)]),
  );
  return z.object(shape).strict();
}

export function isNakedBreakdown(
  bd: Record<string, unknown>,
): bd is { clarity: number } {
  return typeof bd.clarity === "number" && Object.keys(bd).length === 1;
}
