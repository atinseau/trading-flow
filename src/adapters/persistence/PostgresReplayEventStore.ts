import { replayEvents } from "@adapters/persistence/schema";
import type { EventPayload } from "@domain/events/schemas";
import type {
  NewReplayEvent,
  ReplayEventStore,
  StoredReplayEvent,
} from "@domain/ports/ReplayEventStore";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;
type Row = typeof replayEvents.$inferSelect;

function rowToStored(row: Row): StoredReplayEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    setupId: row.setupId,
    sequence: row.sequence,
    occurredAt: row.occurredAt,
    stage: row.stage,
    actor: row.actor,
    type: row.type,
    scoreDelta: Number(row.scoreDelta),
    scoreAfter: row.scoreAfter !== null ? Number(row.scoreAfter) : null,
    statusBefore: row.statusBefore,
    statusAfter: row.statusAfter,
    payload: row.payload as EventPayload,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    inputHash: row.inputHash,
    latencyMs: row.latencyMs,
    cacheHit: row.cacheHit,
  };
}

export class PostgresReplayEventStore implements ReplayEventStore {
  constructor(private readonly db: DB) {}

  async append(sessionId: string, event: NewReplayEvent): Promise<StoredReplayEvent> {
    return await this.db.transaction(async (tx) => {
      // Atomic sequence inside the transaction to defeat concurrent
      // appends (same pattern as live PostgresEventStore).
      const [seqRow] = await tx
        .select({ max: sql<number>`COALESCE(MAX(${replayEvents.sequence}), 0)` })
        .from(replayEvents)
        .where(eq(replayEvents.sessionId, sessionId));
      const sequence = Number(seqRow?.max ?? 0) + 1;

      const [row] = await tx
        .insert(replayEvents)
        .values({
          sessionId,
          setupId: event.setupId,
          sequence,
          occurredAt: event.occurredAt,
          stage: event.stage,
          actor: event.actor,
          type: event.type,
          scoreDelta: event.scoreDelta.toString(),
          scoreAfter:
            event.scoreAfter !== null && event.scoreAfter !== undefined
              ? event.scoreAfter.toString()
              : null,
          statusBefore: event.statusBefore ?? null,
          statusAfter: event.statusAfter ?? null,
          payload: event.payload,
          provider: event.provider ?? null,
          model: event.model ?? null,
          promptVersion: event.promptVersion ?? null,
          inputHash: event.inputHash ?? null,
          latencyMs: event.latencyMs ?? null,
          cacheHit: event.cacheHit ?? false,
        })
        .returning();
      if (!row) throw new Error("INSERT replay_events returned no row");
      return rowToStored(row);
    });
  }

  async listBySession(
    sessionId: string,
    opts?: { sinceSeq?: number },
  ): Promise<StoredReplayEvent[]> {
    const conditions = [eq(replayEvents.sessionId, sessionId)];
    if (opts?.sinceSeq !== undefined) {
      conditions.push(gt(replayEvents.sequence, opts.sinceSeq));
    }
    const rows = await this.db
      .select()
      .from(replayEvents)
      .where(and(...conditions))
      .orderBy(asc(replayEvents.sequence));
    return rows.map(rowToStored);
  }

  async countBySession(sessionId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(replayEvents)
      .where(eq(replayEvents.sessionId, sessionId));
    return Number(row?.count ?? 0);
  }
}
