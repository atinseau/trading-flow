import type { TickSnapshot } from "@domain/entities/TickSnapshot";
import type { TickSnapshotStore } from "@domain/ports/TickSnapshotStore";
import { and, asc, between, desc, eq } from "drizzle-orm";
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
        lastClose: s.lastClose != null ? String(s.lastClose) : null,
        preFilterPass: s.preFilterPass,
      })
      .returning();
    if (!row) throw new Error("tick snapshot insert returned no row");
    return mapTick(row);
  }

  async get(id: string): Promise<TickSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(tickSnapshots)
      .where(eq(tickSnapshots.id, id))
      .limit(1);
    return row ? mapTick(row) : null;
  }

  async listInWindow(args: { watchId: string; from: Date; to: Date }): Promise<TickSnapshot[]> {
    const rows = await this.db
      .select()
      .from(tickSnapshots)
      .where(
        and(
          eq(tickSnapshots.watchId, args.watchId),
          between(tickSnapshots.tickAt, args.from, args.to),
        ),
      )
      .orderBy(asc(tickSnapshots.tickAt));
    return rows.map(mapTick);
  }

  async latestForWatch(watchId: string): Promise<TickSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(tickSnapshots)
      .where(eq(tickSnapshots.watchId, watchId))
      .orderBy(desc(tickSnapshots.tickAt))
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
    lastClose: r.lastClose != null ? Number(r.lastClose) : null,
    preFilterPass: r.preFilterPass,
  };
}
