/**
 * Render a scalar series as a compact arrow-separated string :
 *   `42.3 → 45.1 → 48.0 → 51.2 → 47.8 → 44.5 → 41.9 → 39.8 → 40.3 → 40.17`
 *
 * Designed to live on a single Markdown line inside an indicator's prompt
 * fragment. `null` values (NaN-period prefix, gaps) become `—`. Returns an
 * empty string for empty/missing series so the caller can skip the line.
 */
export function formatScalarHistory(
  series: ReadonlyArray<number | null> | undefined,
  opts: { decimals: number; max?: number } = { decimals: 2 },
): string {
  if (!series || series.length === 0) return "";
  const max = opts.max ?? series.length;
  const tail = series.slice(-max);
  return tail
    .map((v) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(opts.decimals)))
    .join(" → ");
}
