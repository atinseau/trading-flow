import type { TickSnapshot } from "@domain/entities/TickSnapshot";

export interface TickSnapshotStore {
  create(snapshot: Omit<TickSnapshot, "id">): Promise<TickSnapshot>;
  get(id: string): Promise<TickSnapshot | null>;
  listInWindow(args: { watchId: string; from: Date; to: Date }): Promise<TickSnapshot[]>;
  /** Most recent snapshot for the watch, or null if none exist. Used by the
      finalizer to pull fresh indicators (events don't carry indicator state)
      and the live-price proxy `lastClose`. */
  latestForWatch(watchId: string): Promise<TickSnapshot | null>;
}
