import type { EventStore, NewEvent, SetupStateUpdate, StoredEvent } from "@domain/ports/EventStore";

export class InMemoryEventStore implements EventStore {
  events: StoredEvent[] = [];
  setupStateAfterAppend = new Map<string, SetupStateUpdate>();

  async append(event: NewEvent, setupUpdate: SetupStateUpdate): Promise<StoredEvent> {
    const stored: StoredEvent = {
      ...event,
      id: crypto.randomUUID(),
      occurredAt: new Date(),
    };
    this.events.push(stored);
    this.setupStateAfterAppend.set(event.setupId, setupUpdate);
    return stored;
  }

  async listForSetup(setupId: string): Promise<StoredEvent[]> {
    return this.events.filter((e) => e.setupId === setupId).sort((a, b) => a.sequence - b.sequence);
  }

  async findByInputHash(setupId: string, inputHash: string): Promise<StoredEvent | null> {
    return this.events.find((e) => e.setupId === setupId && e.inputHash === inputHash) ?? null;
  }

  async nextSequence(setupId: string): Promise<number> {
    const max = this.events
      .filter((e) => e.setupId === setupId)
      .reduce((m, e) => Math.max(m, e.sequence), 0);
    return max + 1;
  }

  reset(): void {
    this.events = [];
    this.setupStateAfterAppend.clear();
  }
}
