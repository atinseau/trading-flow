import { createHash } from "node:crypto";

export type HashInput = {
  setupId: string;
  promptVersion: string;
  ohlcvSnapshot: string;
  chartUri: string;
  indicators: Record<string, number>;
};

export function computeInputHash(input: HashInput): string {
  const sortedIndicators = Object.fromEntries(
    Object.entries(input.indicators).sort(([a], [b]) => a.localeCompare(b)),
  );
  const canonical = JSON.stringify({
    setupId: input.setupId,
    promptVersion: input.promptVersion,
    ohlcvSnapshot: input.ohlcvSnapshot,
    chartUri: input.chartUri,
    indicators: sortedIndicators,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
