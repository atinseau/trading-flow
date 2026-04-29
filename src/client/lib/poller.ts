import { events, setups, tickSnapshots, watchStates } from "@adapters/persistence/schema";
import type { Broadcaster } from "@client/lib/broadcaster";
import { childLogger } from "@client/lib/logger";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

const log = childLogger({ module: "poller" });

export type PollerOpts = {
  pool: pg.Pool;
  broadcaster: Broadcaster;
  intervalMs?: number;
  batchSize?: number;
};

/**
 * Postgres timestamps have microsecond precision, but JS Dates only carry
 * millisecond precision. So `cursor = row.someTs` then querying with `> cursor`
 * can re-return the same row when its sub-millisecond fraction is non-zero.
 * We dedupe by row identity for append-only tables and by `(id, updatedAt)`
 * tuples for mutable tables to suppress duplicates regardless of precision.
 */
const RECENT_LIMIT = 1024;

class RecentSet {
  private set = new Set<string>();
  private order: string[] = [];
  has(key: string): boolean {
    return this.set.has(key);
  }
  add(key: string): void {
    if (this.set.has(key)) return;
    this.set.add(key);
    this.order.push(key);
    while (this.order.length > RECENT_LIMIT) {
      const k = this.order.shift();
      if (k !== undefined) this.set.delete(k);
    }
  }
}

export function startPoller(opts: PollerOpts): () => void {
  const { pool, broadcaster } = opts;
  const interval = opts.intervalMs ?? 1500;
  const batch = opts.batchSize ?? 200;
  const db = drizzle(pool);

  const cursors = {
    events: new Date(Date.now() - 5_000),
    setups: new Date(Date.now() - 5_000),
    ticks: new Date(Date.now() - 5_000),
    watchStates: new Date(Date.now() - 5_000),
  };

  const seen = {
    events: new RecentSet(),
    setups: new RecentSet(),
    ticks: new RecentSet(),
    watchStates: new RecentSet(),
  };

  let stopped = false;

  async function poll(): Promise<void> {
    if (stopped) return;
    try {
      const eventsRows = await db
        .select({
          id: events.id,
          setupId: events.setupId,
          sequence: events.sequence,
          occurredAt: events.occurredAt,
          type: events.type,
          scoreDelta: events.scoreDelta,
          scoreAfter: events.scoreAfter,
          statusBefore: events.statusBefore,
          statusAfter: events.statusAfter,
          payload: events.payload,
          provider: events.provider,
          model: events.model,
          costUsd: events.costUsd,
          latencyMs: events.latencyMs,
          watchId: setups.watchId,
        })
        .from(events)
        .innerJoin(setups, eq(events.setupId, setups.id))
        .where(gt(events.occurredAt, cursors.events))
        .orderBy(asc(events.occurredAt), asc(events.id))
        .limit(batch);

      for (const r of eventsRows) {
        if (seen.events.has(r.id)) continue;
        seen.events.add(r.id);
        broadcaster.emit("events", r);
        if (r.occurredAt > cursors.events) cursors.events = r.occurredAt;
      }

      const setupRows = await db
        .select()
        .from(setups)
        .where(gt(setups.updatedAt, cursors.setups))
        .orderBy(asc(setups.updatedAt))
        .limit(batch);
      for (const r of setupRows) {
        const key = `${r.id}:${r.updatedAt.getTime()}`;
        if (seen.setups.has(key)) continue;
        seen.setups.add(key);
        broadcaster.emit("setups", r);
        if (r.updatedAt > cursors.setups) cursors.setups = r.updatedAt;
      }

      const tickRows = await db
        .select()
        .from(tickSnapshots)
        .where(gt(tickSnapshots.createdAt, cursors.ticks))
        .orderBy(asc(tickSnapshots.createdAt))
        .limit(batch);
      for (const r of tickRows) {
        if (seen.ticks.has(r.id)) continue;
        seen.ticks.add(r.id);
        broadcaster.emit("ticks", r);
        if (r.createdAt > cursors.ticks) cursors.ticks = r.createdAt;
      }

      const watchRows = await db
        .select()
        .from(watchStates)
        .where(
          and(isNotNull(watchStates.lastTickAt), gt(watchStates.lastTickAt, cursors.watchStates)),
        );
      for (const r of watchRows) {
        if (!r.lastTickAt) continue;
        const key = `${r.watchId}:${r.lastTickAt.getTime()}`;
        if (seen.watchStates.has(key)) continue;
        seen.watchStates.add(key);
        broadcaster.emit("watches", r);
        if (r.lastTickAt > cursors.watchStates) cursors.watchStates = r.lastTickAt;
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, "poll iteration failed");
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async (): Promise<void> => {
    const start = Date.now();
    await poll();
    const elapsed = Date.now() - start;
    if (elapsed > interval * 3) log.warn({ elapsed }, "poll took longer than 3 intervals");
    if (!stopped) timer = setTimeout(tick, Math.max(0, interval - elapsed));
  };
  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
