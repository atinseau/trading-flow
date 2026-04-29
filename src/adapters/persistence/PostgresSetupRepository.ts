import type { Setup } from "@domain/entities/Setup";
import type { AliveSetupSummary, SetupRepository } from "@domain/ports/SetupRepository";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";
import { TERMINAL_STATUSES } from "@domain/state-machine/setupTransitions";
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { setups, watchConfigs } from "./schema";

type DB = ReturnType<typeof drizzle>;

export class PostgresSetupRepository implements SetupRepository {
  constructor(
    private db: DB,
    private candleDurationMsResolver: (tf: string) => number,
  ) {}

  async create(setup: Omit<Setup, "createdAt" | "updatedAt" | "closedAt">): Promise<Setup> {
    const [row] = await this.db
      .insert(setups)
      .values({
        id: setup.id,
        watchId: setup.watchId,
        asset: setup.asset,
        timeframe: setup.timeframe,
        status: setup.status,
        currentScore: String(setup.currentScore),
        patternHint: setup.patternHint,
        invalidationLevel: setup.invalidationLevel != null ? String(setup.invalidationLevel) : null,
        direction: setup.direction,
        ttlCandles: setup.ttlCandles,
        ttlExpiresAt: setup.ttlExpiresAt,
        workflowId: setup.workflowId,
      })
      .returning();
    return mapSetup(row!);
  }

  async get(id: string): Promise<Setup | null> {
    const [row] = await this.db.select().from(setups).where(eq(setups.id, id)).limit(1);
    return row ? mapSetup(row) : null;
  }

  async listAlive(watchId: string): Promise<AliveSetupSummary[]> {
    const terminalArr = [...TERMINAL_STATUSES];
    const rows = await this.db
      .select()
      .from(setups)
      .where(and(eq(setups.watchId, watchId), notInArray(setups.status, terminalArr)));
    return rows.map((r) => this.toSummary(r));
  }

  async listAliveWithInvalidation(watchId: string): Promise<AliveSetupSummary[]> {
    const terminalArr = [...TERMINAL_STATUSES];
    const rows = await this.db
      .select()
      .from(setups)
      .where(
        and(
          eq(setups.watchId, watchId),
          notInArray(setups.status, terminalArr),
          isNotNull(setups.invalidationLevel),
        ),
      );
    return rows.map((r) => this.toSummary(r));
  }

  async listAliveBySymbol(symbol: string, source: string): Promise<AliveSetupSummary[]> {
    const terminalArr = [...TERMINAL_STATUSES];
    const rows = await this.db
      .select({
        id: setups.id,
        watchId: setups.watchId,
        asset: setups.asset,
        timeframe: setups.timeframe,
        status: setups.status,
        currentScore: setups.currentScore,
        patternHint: setups.patternHint,
        invalidationLevel: setups.invalidationLevel,
        direction: setups.direction,
        ttlCandles: setups.ttlCandles,
        ttlExpiresAt: setups.ttlExpiresAt,
        workflowId: setups.workflowId,
        createdAt: setups.createdAt,
      })
      .from(setups)
      .innerJoin(watchConfigs, eq(setups.watchId, watchConfigs.id))
      .where(
        and(
          eq(setups.asset, symbol),
          sql`${watchConfigs.config}->'asset'->>'source' = ${source}`,
          notInArray(setups.status, terminalArr),
        ),
      );
    return rows.map((r) => this.toSummary(r as typeof setups.$inferSelect));
  }

  async markClosed(id: string, finalStatus: SetupStatus): Promise<void> {
    await this.db
      .update(setups)
      .set({
        status: finalStatus,
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(setups.id, id));
  }

  private toSummary(r: typeof setups.$inferSelect): AliveSetupSummary {
    const candleMs = this.candleDurationMsResolver(r.timeframe);
    const ageMs = Date.now() - r.createdAt.getTime();
    const ageInCandles = Math.floor(ageMs / candleMs);
    return {
      id: r.id,
      workflowId: r.workflowId,
      asset: r.asset,
      timeframe: r.timeframe,
      status: r.status as SetupStatus,
      currentScore: Number(r.currentScore),
      invalidationLevel: r.invalidationLevel != null ? Number(r.invalidationLevel) : null,
      direction: r.direction as "LONG" | "SHORT" | null,
      patternHint: r.patternHint,
      ageInCandles,
    };
  }
}

function mapSetup(r: typeof setups.$inferSelect): Setup {
  return {
    id: r.id,
    watchId: r.watchId,
    asset: r.asset,
    timeframe: r.timeframe,
    status: r.status as SetupStatus,
    currentScore: Number(r.currentScore),
    patternHint: r.patternHint,
    invalidationLevel: r.invalidationLevel != null ? Number(r.invalidationLevel) : null,
    direction: r.direction as "LONG" | "SHORT" | null,
    ttlCandles: r.ttlCandles,
    ttlExpiresAt: r.ttlExpiresAt,
    workflowId: r.workflowId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    closedAt: r.closedAt,
  };
}
