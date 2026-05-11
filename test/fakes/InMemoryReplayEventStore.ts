import type {
  NewReplayEvent,
  ReplayEventStore,
  StoredReplayEvent,
} from "@domain/ports/ReplayEventStore";

export class InMemoryReplayEventStore implements ReplayEventStore {
  events: StoredReplayEvent[] = [];

  async append(sessionId: string, event: NewReplayEvent): Promise<StoredReplayEvent> {
    // Atomic sequence per session — mirrors Postgres MAX(sequence)+1
    // semantics so tests behave like production.
    const max = this.events
      .filter((e) => e.sessionId === sessionId)
      .reduce((m, e) => Math.max(m, e.sequence), 0);
    const stored: StoredReplayEvent = {
      ...event,
      id: crypto.randomUUID(),
      sessionId,
      sequence: max + 1,
    };
    this.events.push(stored);
    return stored;
  }

  async listBySession(
    sessionId: string,
    opts?: { sinceSeq?: number },
  ): Promise<StoredReplayEvent[]> {
    return this.events
      .filter(
        (e) =>
          e.sessionId === sessionId && (opts?.sinceSeq === undefined || e.sequence > opts.sinceSeq),
      )
      .sort((a, b) => a.sequence - b.sequence);
  }

  async countBySession(sessionId: string): Promise<number> {
    return this.events.filter((e) => e.sessionId === sessionId).length;
  }

  reset(): void {
    this.events = [];
  }
}
