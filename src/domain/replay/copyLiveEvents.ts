import type { LiveEventQueryByWindow } from "@domain/ports/LiveEventQueryByWindow";
import type { ReplayEventStore } from "@domain/ports/ReplayEventStore";

export type CopyLiveEventsDeps = {
  liveEventQuery: LiveEventQueryByWindow;
  replayEventStore: ReplayEventStore;
};

export type CopyLiveEventsArgs = {
  sessionId: string;
  watchId: string;
  windowStartAt: Date;
  windowEndAt: Date;
};

export type CopyLiveEventsResult = {
  copied: number;
};

/**
 * At session creation time, copies the live events that occurred within
 * `[windowStartAt, windowEndAt]` for the given watch into the session's
 * `replay_events` table. Used as the Jalon 1 baseline so the user can
 * navigate the session even before any interactive step.
 *
 * Reuses each event's original `setupId` so the projection downstream
 * (Task 4.5) groups them correctly. The replay sequence is assigned
 * fresh by the ReplayEventStore — the original live sequence is NOT
 * preserved (it lives in a separate numbering space scoped to live
 * setups).
 *
 * Pure orchestration: depends only on the two ports, no I/O of its own.
 */
export async function copyLiveEventsToReplay(
  deps: CopyLiveEventsDeps,
  args: CopyLiveEventsArgs,
): Promise<CopyLiveEventsResult> {
  const live = await deps.liveEventQuery.listEventsInWindow({
    watchId: args.watchId,
    windowStartAt: args.windowStartAt,
    windowEndAt: args.windowEndAt,
  });

  for (const e of live) {
    await deps.replayEventStore.append(args.sessionId, {
      setupId: e.setupId,
      occurredAt: e.occurredAt,
      stage: e.stage,
      actor: e.actor,
      type: e.type,
      scoreDelta: e.scoreDelta,
      scoreAfter: e.scoreAfter,
      statusBefore: e.statusBefore,
      statusAfter: e.statusAfter,
      payload: e.payload,
      provider: e.provider,
      model: e.model,
      promptVersion: e.promptVersion,
      inputHash: e.inputHash,
      latencyMs: e.latencyMs,
      cacheHit: false, // live events were never cache hits in their original execution
    });
  }

  return { copied: live.length };
}
