import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

/**
 * Builds a per-watch indicators schema from the active plugin set.
 * In naked mode (no active plugins), returns an empty object schema.
 *
 * Each plugin contributes its own keys via scalarSchemaFragment().
 * The returned schema is `.strict()` — extra keys are rejected, which
 * surfaces stale code paths during refactors.
 */
export function buildIndicatorsSchema(
  plugins: ReadonlyArray<IndicatorPlugin>,
): z.ZodObject<z.ZodRawShape> {
  if (plugins.length === 0) return z.object({}).strict();
  const shape: z.ZodRawShape = {};
  for (const p of plugins) {
    Object.assign(shape, p.scalarSchemaFragment());
  }
  return z.object(shape).strict();
}

/** Loose carrier type for compute-side scalars before per-watch validation. */
export type IndicatorScalars = Record<string, unknown>;
