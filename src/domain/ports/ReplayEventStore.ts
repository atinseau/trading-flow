import type { EventPayload } from "@domain/events/schemas";

export type NewReplayEvent = {
  /** Caller-supplied setup id (workflow-generated for replay). Nullable for tick-level events. */
  setupId: string | null;
  occurredAt: Date;
  stage: string;
  actor: string;
  type: string;
  scoreDelta: number;
  scoreAfter?: number | null;
  statusBefore?: string | null;
  statusAfter?: string | null;
  payload: EventPayload;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  inputHash?: string | null;
  latencyMs?: number | null;
  cacheHit?: boolean;
};

export type StoredReplayEvent = NewReplayEvent & {
  id: string;
  sessionId: string;
  sequence: number;
};

export interface ReplayEventStore {
  /**
   * Append an event to the given session. The adapter assigns `sequence`
   * atomically via MAX(sequence)+1 inside the transaction; concurrent
   * appends serialize correctly via the unique (session_id, sequence)
   * index.
   */
  append(sessionId: string, event: NewReplayEvent): Promise<StoredReplayEvent>;

  /** Returns events ordered by sequence ascending. */
  listBySession(sessionId: string, opts?: { sinceSeq?: number }): Promise<StoredReplayEvent[]>;

  countBySession(sessionId: string): Promise<number>;
}
