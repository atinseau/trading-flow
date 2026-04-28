import type { AliveSetupSummary } from "@domain/ports/SetupRepository";

export type ProposedSetup = {
  type: string;
  direction: "LONG" | "SHORT";
  keyLevels: { invalidation: number; entry?: number; target?: number };
  initialScore: number;
  rawObservation: string;
};

export type DedupResult = {
  creates: ProposedSetup[];
  corroborateInstead: {
    setupId: string;
    evidence: ProposedSetup;
    confidenceDeltaSuggested: number;
  }[];
};

export function dedupNewSetups(
  proposed: ProposedSetup[],
  alive: AliveSetupSummary[],
  cfg: { similarSetupWindowCandles: number; similarPriceTolerancePct: number },
): DedupResult {
  const result: DedupResult = { creates: [], corroborateInstead: [] };

  for (const p of proposed) {
    const conflict = alive.find(
      (a) =>
        a.patternHint === p.type &&
        a.direction === p.direction &&
        a.invalidationLevel != null &&
        (Math.abs(a.invalidationLevel - p.keyLevels.invalidation) / a.invalidationLevel) * 100 <
          cfg.similarPriceTolerancePct &&
        a.ageInCandles < cfg.similarSetupWindowCandles,
    );

    if (conflict) {
      result.corroborateInstead.push({
        setupId: conflict.id,
        evidence: p,
        confidenceDeltaSuggested: 5,
      });
    } else {
      result.creates.push(p);
    }
  }

  return result;
}
