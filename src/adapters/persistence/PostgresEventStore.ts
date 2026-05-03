import type { EventStore, NewEvent, SetupStateUpdate, StoredEvent } from "@domain/ports/EventStore";
import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { events, setups } from "./schema";

type DB = ReturnType<typeof drizzle>;

export class PostgresEventStore implements EventStore {
  constructor(private db: DB) {}

  async append(event: NewEvent, setupUpdate: SetupStateUpdate): Promise<StoredEvent> {
    return await this.db.transaction(async (tx) => {
      // Compute sequence atomically inside the transaction so that concurrent
      // appends (e.g. main workflow path + signal handler racing) cannot
      // collide on the unique (setup_id, sequence) constraint. We ignore the
      // caller-supplied event.sequence in favor of MAX+1 read under the same
      // tx — this preserves monotonic ordering without the workflow having
      // to serialize calls itself.
      const [seqRow] = await tx
        .select({ max: sql<number>`COALESCE(MAX(${events.sequence}), 0)` })
        .from(events)
        .where(eq(events.setupId, event.setupId));
      const sequence = Number(seqRow?.max ?? 0) + 1;

      const [stored] = await tx
        .insert(events)
        .values({
          setupId: event.setupId,
          sequence,
          stage: event.stage,
          actor: event.actor,
          type: event.type,
          scoreDelta: String(event.scoreDelta),
          scoreAfter: String(event.scoreAfter),
          statusBefore: event.statusBefore,
          statusAfter: event.statusAfter,
          payload: event.payload,
          provider: event.provider ?? null,
          model: event.model ?? null,
          promptVersion: event.promptVersion ?? null,
          inputHash: event.inputHash ?? null,
          latencyMs: event.latencyMs ?? null,
        })
        .returning();
      if (!stored) throw new Error("event insert returned no row");

      const updateValues: Record<string, unknown> = {
        currentScore: String(setupUpdate.score),
        status: setupUpdate.status,
        updatedAt: new Date(),
      };
      if (setupUpdate.invalidationLevel != null) {
        updateValues.invalidationLevel = String(setupUpdate.invalidationLevel);
      }
      await tx.update(setups).set(updateValues).where(eq(setups.id, event.setupId));

      return mapStored(stored);
    });
  }

  async listForSetup(setupId: string): Promise<StoredEvent[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(eq(events.setupId, setupId))
      .orderBy(events.sequence);
    return rows.map(mapStored);
  }

  async findByInputHash(setupId: string, inputHash: string): Promise<StoredEvent | null> {
    const [row] = await this.db
      .select()
      .from(events)
      .where(and(eq(events.setupId, setupId), eq(events.inputHash, inputHash)))
      .limit(1);
    return row ? mapStored(row) : null;
  }
}

function mapStored(r: typeof events.$inferSelect): StoredEvent {
  return {
    id: r.id,
    setupId: r.setupId,
    sequence: r.sequence,
    occurredAt: r.occurredAt,
    stage: r.stage as StoredEvent["stage"],
    actor: r.actor,
    type: r.type as StoredEvent["type"],
    scoreDelta: Number(r.scoreDelta),
    scoreAfter: Number(r.scoreAfter),
    statusBefore: r.statusBefore as StoredEvent["statusBefore"],
    statusAfter: r.statusAfter as StoredEvent["statusAfter"],
    payload: r.payload,
    provider: r.provider ?? undefined,
    model: r.model ?? undefined,
    promptVersion: r.promptVersion ?? undefined,
    inputHash: r.inputHash ?? undefined,
    latencyMs: r.latencyMs ?? undefined,
  };
}
