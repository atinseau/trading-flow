import type { EventPayload } from "@domain/events/schemas";
import type { EventStage, EventTypeName } from "@domain/events/types";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type NewEvent = {
  setupId: string;
  sequence: number;
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
  costUsd?: number;
  latencyMs?: number;
};

export type StoredEvent = NewEvent & {
  id: string;
  occurredAt: Date;
};

export type SetupStateUpdate = {
  score: number;
  status: SetupStatus;
  invalidationLevel?: number | null;
};

export interface EventStore {
  /** Append event AND update setups state in same transaction */
  append(event: NewEvent, setupUpdate: SetupStateUpdate): Promise<StoredEvent>;
  listForSetup(setupId: string): Promise<StoredEvent[]>;
  findByInputHash(setupId: string, inputHash: string): Promise<StoredEvent | null>;
  nextSequence(setupId: string): Promise<number>;
}
