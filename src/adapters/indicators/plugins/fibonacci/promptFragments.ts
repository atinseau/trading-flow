/** Detector-facing fragment. Returns null when no swing pair confirmed. */
export function detectorFragment(scalars: Record<string, unknown>): string | null {
  const dir = scalars.fibDirection;
  const high = scalars.fibAnchorHigh;
  const low = scalars.fibAnchorLow;
  if (typeof dir !== "string" || typeof high !== "number" || typeof low !== "number") {
    return null;
  }
  const f382 = scalars.fib_0_382 as number;
  const f500 = scalars.fib_0_500 as number;
  const f618 = scalars.fib_0_618 as number;
  const f1272 = scalars.fib_1_272 as number;
  const f1618 = scalars.fib_1_618 as number;
  return [
    `Fibonacci (${dir}):`,
    `  - anchor: high=${high.toFixed(4)} low=${low.toFixed(4)}`,
    `  - 0.382: ${f382.toFixed(4)}`,
    `  - 0.500: ${f500.toFixed(4)} (mid-retracement)`,
    `  - 0.618: ${f618.toFixed(4)} (golden zone)`,
    `  - 1.272: ${f1272.toFixed(4)} (extension)`,
    `  - 1.618: ${f1618.toFixed(4)} (extension)`,
  ].join("\n");
}
