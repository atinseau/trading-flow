import type { EventPayload } from "@domain/events/schemas";
import type { EventStage, EventTypeName } from "@domain/events/types";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type NewEvent = {
  setupId: string;
  /**
   * Optional — store assigns the sequence atomically inside the append
   * transaction (MAX+1) so concurrent appenders cannot collide on the
   * unique (setup_id, sequence) constraint. Callers should consume the
   * authoritative `sequence` from the returned `StoredEvent`.
   */
  sequence?: number;
  stage: EventStage;
  actor: string;
  type: EventTypeName;
  scoreDelta: number;
  scoreAfter: number;
  statusBefore: SetupStatus;
  statusAfter: SetupStatus;
  payload: EventPayload;
  provider?: string;
  model?: string;
  promptVersion?: string;
  inputHash?: string;
  latencyMs?: number;
};

export type StoredEvent = Omit<NewEvent, "sequence"> & {
  id: string;
  sequence: number;
  occurredAt: Date;
};

export type SetupStateUpdate = {
  score: number;
  status: SetupStatus;
  invalidationLevel?: number | null;
};

export interface EventStore {
  /** Append event AND update setups state in same transaction. The store
   * assigns `sequence` atomically; consume `result.sequence`. */
  append(event: NewEvent, setupUpdate: SetupStateUpdate): Promise<StoredEvent>;
  listForSetup(setupId: string): Promise<StoredEvent[]>;
  findByInputHash(setupId: string, inputHash: string): Promise<StoredEvent | null>;
}
