import type {
  ListFilter,
  NewReplaySessionInput,
  ReplaySessionRepository,
} from "@domain/ports/ReplaySessionRepository";
import type { ReplaySession, ReplaySessionStatus } from "@domain/replay/ReplaySession";

export class InMemoryReplaySessionRepository implements ReplaySessionRepository {
  sessions: ReplaySession[] = [];

  async create(input: NewReplaySessionInput): Promise<ReplaySession> {
    const now = new Date();
    const session: ReplaySession = {
      id: input.id ?? crypto.randomUUID(),
      watchId: input.watchId,
      name: input.name,
      status: input.status,
      windowStartAt: input.windowStartAt,
      windowEndAt: input.windowEndAt,
      workflowId: input.workflowId,
      configSnapshot: input.configSnapshot,
      lessonsMode: input.lessonsMode,
      feedbackMode: input.feedbackMode,
      costCapUsd: input.costCapUsd,
      costUsdSoFar: 0,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.push(session);
    return session;
  }

  async get(id: string): Promise<ReplaySession | null> {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  async list(filter: ListFilter): Promise<ReplaySession[]> {
    let out = [...this.sessions];
    if (filter.watchId) out = out.filter((s) => s.watchId === filter.watchId);
    if (filter.status) out = out.filter((s) => s.status === filter.status);
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (filter.limit) out = out.slice(0, filter.limit);
    return out;
  }

  async updateStatus(
    id: string,
    status: ReplaySessionStatus,
    failureReason?: string,
  ): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    s.status = status;
    if (failureReason !== undefined) s.failureReason = failureReason;
    s.updatedAt = new Date();
  }

  async incrementCost(id: string, deltaUsd: number): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    s.costUsdSoFar += deltaUsd;
    s.updatedAt = new Date();
  }

  async delete(id: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== id);
  }

  reset(): void {
    this.sessions = [];
  }
}
