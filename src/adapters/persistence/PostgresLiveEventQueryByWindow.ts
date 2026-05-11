import { events, setups } from "@adapters/persistence/schema";
import type { EventPayload } from "@domain/events/schemas";
import type {
  LiveEventInWindow,
  LiveEventQueryByWindow,
} from "@domain/ports/LiveEventQueryByWindow";
import { and, asc, between, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

export class PostgresLiveEventQueryByWindow implements LiveEventQueryByWindow {
  constructor(private readonly db: DB) {}

  async listEventsInWindow(args: {
    watchId: string;
    windowStartAt: Date;
    windowEndAt: Date;
  }): Promise<LiveEventInWindow[]> {
    const rows = await this.db
      .select({
        setupId: events.setupId,
        watchId: setups.watchId,
        occurredAt: events.occurredAt,
        sequence: events.sequence,
        stage: events.stage,
        actor: events.actor,
        type: events.type,
        scoreDelta: events.scoreDelta,
        scoreAfter: events.scoreAfter,
        statusBefore: events.statusBefore,
        statusAfter: events.statusAfter,
        payload: events.payload,
        provider: events.provider,
        model: events.model,
        promptVersion: events.promptVersion,
        inputHash: events.inputHash,
        latencyMs: events.latencyMs,
      })
      .from(events)
      .innerJoin(setups, eq(events.setupId, setups.id))
      .where(
        and(
          eq(setups.watchId, args.watchId),
          between(events.occurredAt, args.windowStartAt, args.windowEndAt),
        ),
      )
      .orderBy(asc(events.occurredAt), asc(events.sequence));

    return rows.map((r) => ({
      setupId: r.setupId,
      watchId: r.watchId,
      occurredAt: r.occurredAt,
      sequence: r.sequence,
      stage: r.stage,
      actor: r.actor,
      type: r.type,
      scoreDelta: Number(r.scoreDelta),
      scoreAfter: r.scoreAfter !== null ? Number(r.scoreAfter) : null,
      statusBefore: r.statusBefore,
      statusAfter: r.statusAfter,
      payload: r.payload as EventPayload,
      provider: r.provider,
      model: r.model,
      promptVersion: r.promptVersion,
      inputHash: r.inputHash,
      latencyMs: r.latencyMs,
    }));
  }
}
