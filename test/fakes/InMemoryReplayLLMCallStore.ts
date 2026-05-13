import type {
  CostByStage,
  NewReplayLLMCall,
  ReplayLLMCallStore,
} from "@domain/ports/ReplayLLMCallStore";

export class InMemoryReplayLLMCallStore implements ReplayLLMCallStore {
  calls: (NewReplayLLMCall & { occurredAt: Date })[] = [];

  async record(call: NewReplayLLMCall): Promise<void> {
    this.calls.push({ ...call, occurredAt: new Date() });
  }

  async costBreakdown(sessionId: string): Promise<CostByStage[]> {
    const scoped = this.calls.filter((c) => c.sessionId === sessionId);
    const byStage = new Map<string, CostByStage>();
    for (const c of scoped) {
      const cur = byStage.get(c.stage) ?? {
        stage: c.stage,
        totalCostUsd: 0,
        calls: 0,
        cacheHits: 0,
      };
      cur.totalCostUsd += c.costUsd;
      cur.calls += 1;
      if (c.cacheHit) cur.cacheHits += 1;
      byStage.set(c.stage, cur);
    }
    return [...byStage.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  reset(): void {
    this.calls = [];
  }
}
