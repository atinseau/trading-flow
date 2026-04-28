import type { TickSnapshot } from "@domain/entities/TickSnapshot";
import type { TickSnapshotStore } from "@domain/ports/TickSnapshotStore";

export class InMemoryTickSnapshotStore implements TickSnapshotStore {
  store = new Map<string, TickSnapshot>();

  async create(s: Omit<TickSnapshot, "id">): Promise<TickSnapshot> {
    const full: TickSnapshot = { ...s, id: crypto.randomUUID() };
    this.store.set(full.id, full);
    return full;
  }

  async get(id: string): Promise<TickSnapshot | null> {
    return this.store.get(id) ?? null;
  }

  reset(): void {
    this.store.clear();
  }
}
