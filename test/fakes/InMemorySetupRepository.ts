import type { Setup } from "@domain/entities/Setup";
import { parseTimeframeToMs } from "@domain/ports/Clock";
import type { AliveSetupSummary, SetupRepository } from "@domain/ports/SetupRepository";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";
import { TERMINAL_STATUSES } from "@domain/state-machine/setupTransitions";

export class InMemorySetupRepository implements SetupRepository {
  setups = new Map<string, Setup>();

  async create(setup: Omit<Setup, "createdAt" | "updatedAt" | "closedAt">): Promise<Setup> {
    const now = new Date();
    const full: Setup = { ...setup, createdAt: now, updatedAt: now, closedAt: null };
    this.setups.set(full.id, full);
    return full;
  }

  async get(id: string): Promise<Setup | null> {
    return this.setups.get(id) ?? null;
  }

  async listAlive(watchId: string): Promise<AliveSetupSummary[]> {
    return [...this.setups.values()]
      .filter((s) => s.watchId === watchId && !TERMINAL_STATUSES.has(s.status))
      .map((s) => this.toSummary(s));
  }

  async listAliveWithInvalidation(watchId: string): Promise<AliveSetupSummary[]> {
    return (await this.listAlive(watchId)).filter((s) => s.invalidationLevel != null);
  }

  async markClosed(id: string, finalStatus: SetupStatus): Promise<void> {
    const s = this.setups.get(id);
    if (!s) return;
    this.setups.set(id, { ...s, status: finalStatus, closedAt: new Date(), updatedAt: new Date() });
  }

  /** Test util: directly mutate a setup state */
  patch(id: string, updates: Partial<Setup>): void {
    const s = this.setups.get(id);
    if (s) this.setups.set(id, { ...s, ...updates, updatedAt: new Date() });
  }

  private toSummary(s: Setup): AliveSetupSummary {
    const candleMs = parseTimeframeToMs(s.timeframe);
    return {
      id: s.id,
      workflowId: s.workflowId,
      asset: s.asset,
      timeframe: s.timeframe,
      status: s.status,
      currentScore: s.currentScore,
      invalidationLevel: s.invalidationLevel,
      direction: s.direction,
      patternHint: s.patternHint,
      ageInCandles: Math.floor((Date.now() - s.createdAt.getTime()) / candleMs),
    };
  }

  reset(): void {
    this.setups.clear();
  }
}
