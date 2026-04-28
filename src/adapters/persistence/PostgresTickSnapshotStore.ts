import type { TickSnapshot } from "@domain/entities/TickSnapshot";
import type { TickSnapshotStore } from "@domain/ports/TickSnapshotStore";
import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { tickSnapshots } from "./schema";

type DB = ReturnType<typeof drizzle>;

export class PostgresTickSnapshotStore implements TickSnapshotStore {
  constructor(private db: DB) {}

  async create(s: Omit<TickSnapshot, "id">): Promise<TickSnapshot> {
    const [row] = await this.db
      .insert(tickSnapshots)
      .values({
        watchId: s.watchId,
        tickAt: s.tickAt,
        asset: s.asset,
        timeframe: s.timeframe,
        ohlcvUri: s.ohlcvUri,
        chartUri: s.chartUri,
        indicators: s.indicators,
        preFilterPass: s.preFilterPass,
      })
      .returning();
    return mapTick(row!);
  }

  async get(id: string): Promise<TickSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(tickSnapshots)
      .where(eq(tickSnapshots.id, id))
      .limit(1);
    return row ? mapTick(row) : null;
  }
}

function mapTick(r: typeof tickSnapshots.$inferSelect): TickSnapshot {
  return {
    id: r.id,
    watchId: r.watchId,
    tickAt: r.tickAt,
    asset: r.asset,
    timeframe: r.timeframe,
    ohlcvUri: r.ohlcvUri,
    chartUri: r.chartUri,
    indicators: r.indicators,
    preFilterPass: r.preFilterPass,
  };
}
