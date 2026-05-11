import type { EventPayload } from "@domain/events/schemas";

export type LiveEventInWindow = {
  setupId: string;
  watchId: string;
  occurredAt: Date;
  sequence: number; // original sequence in the live events table (preserved for ordering)
  stage: string;
  actor: string;
  type: string;
  scoreDelta: number;
  scoreAfter: number | null;
  statusBefore: string | null;
  statusAfter: string | null;
  payload: EventPayload;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  inputHash: string | null;
  latencyMs: number | null;
};

/**
 * Read-only port for fetching live events in a time window across all
 * setups of a given watch. Used at replay session creation time to copy
 * the live baseline into replay_events (see spec §12 Jalon 1).
 *
 * Distinct from the live EventStore (which is setup-centric) because the
 * replay use case needs cross-setup, time-bounded reads.
 */
export interface LiveEventQueryByWindow {
  listEventsInWindow(args: {
    watchId: string;
    windowStartAt: Date;
    windowEndAt: Date;
  }): Promise<LiveEventInWindow[]>;
}
