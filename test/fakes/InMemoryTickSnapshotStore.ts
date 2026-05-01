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

  async listInWindow(args: { watchId: string; from: Date; to: Date }): Promise<TickSnapshot[]> {
    const out: TickSnapshot[] = [];
    for (const t of this.store.values()) {
      if (t.watchId !== args.watchId) continue;
      if (t.tickAt < args.from || t.tickAt > args.to) continue;
      out.push(t);
    }
    return out.sort((a, b) => a.tickAt.getTime() - b.tickAt.getTime());
  }

  async latestForWatch(watchId: string): Promise<TickSnapshot | null> {
    let latest: TickSnapshot | null = null;
    for (const t of this.store.values()) {
      if (t.watchId !== watchId) continue;
      if (!latest || t.tickAt > latest.tickAt) latest = t;
    }
    return latest;
  }

  reset(): void {
    this.store.clear();
  }
}
