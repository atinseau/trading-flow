/**
 * Shared test helpers for the setup workflow test suite.
 *
 * The leading underscore in the filename is intentional: bun-test's auto-
 * discovery picks up files matching `*.test.ts` / `*.spec.ts`. A plain
 * `setupTestHelpers.ts` would be ignored, but downstream test files are
 * also affected by Bun's path-based heuristics — keeping the underscore
 * makes the intent explicit and matches the convention from the M6
 * code-review fix.
 */

import type { EventTypeName } from "@domain/events/types";

/**
 * Build a fake `persistEvent` that mirrors the production EventStore contract:
 * the store assigns the sequence atomically. Returns a `StoredEvent`-shaped
 * record with monotonically increasing `sequence` per setupId.
 */
export type FakePersistInput = {
  event: {
    setupId: string;
    type: string;
    statusBefore?: string;
    statusAfter?: string;
    [k: string]: unknown;
  };
  setupUpdate: unknown;
};

export function makePersistEvent(onPersist?: (input: FakePersistInput) => void) {
  const seqBySetup = new Map<string, number>();
  return async (input: FakePersistInput) => {
    onPersist?.(input);
    const prev = seqBySetup.get(input.event.setupId) ?? 0;
    const sequence = prev + 1;
    seqBySetup.set(input.event.setupId, sequence);
    return {
      ...input.event,
      sequence,
      id: `evt-${input.event.setupId}-${sequence}`,
      occurredAt: new Date(),
    };
  };
}

export const baseRunReviewerReturn = (
  verdict: unknown,
): {
  verdictJson: string;
  costUsd: number;
  eventAlreadyExisted: boolean;
  inputHash: string;
  promptVersion: string;
  provider: string;
  model: string;
} => ({
  verdictJson: JSON.stringify(verdict),
  costUsd: 0,
  eventAlreadyExisted: false,
  inputHash: "test-hash",
  promptVersion: "reviewer_v1",
  provider: "fake",
  model: "fake-model",
});

/**
 * No-op stubs for every setup-workflow activity. Returns a fully populated
 * activity object so individual tests can spread it and override only the
 * activities they care about:
 *
 * ```ts
 * const activities = {
 *   ...defaultActivityStubs(),
 *   runReviewer: async () => baseRunReviewerReturn({ type: "STRENGTHEN", ... }),
 * };
 * ```
 *
 * Defaults are sensible no-ops:
 * - notify* → return null (skipped)
 * - runReviewer → NEUTRAL verdict
 * - runFinalizer → no-go decision
 * - persistEvent → atomic-sequence fake
 * - killSetup → null (no-op terminal path)
 */
export function defaultActivityStubs() {
  return {
    createSetup: async () => ({}),
    persistEvent: makePersistEvent(),
    runReviewer: async () =>
      baseRunReviewerReturn({ type: "NEUTRAL" as EventTypeName, observations: [] }),
    runFinalizer: async () => ({
      decisionJson: JSON.stringify({ go: false, reasoning: "x" }),
      costUsd: 0,
      promptVersion: "finalizer_v3",
    }),
    markSetupClosed: async () => {},
    listEventsForSetup: async () => [],
    loadSetup: async () => null,
    notifyTelegramConfirmed: async () => null,
    notifyTelegramRejected: async () => null,
    notifyTelegramInvalidatedAfterConfirmed: async () => null,
    notifyTelegramExpired: async () => null,
    notifyTelegramTPHit: async () => null,
    notifyTelegramSLHit: async () => null,
    notifyTelegramSetupCreated: async () => null,
    notifyTelegramReviewerVerdict: async () => null,
    notifyTelegramSetupKilled: async () => null,
    killSetup: async () => null,
  };
}
