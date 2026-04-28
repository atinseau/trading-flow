import type { TickSnapshot } from "@domain/entities/TickSnapshot";

export interface TickSnapshotStore {
  create(snapshot: Omit<TickSnapshot, "id">): Promise<TickSnapshot>;
  get(id: string): Promise<TickSnapshot | null>;
}
