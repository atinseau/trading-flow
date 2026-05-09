import { llmCalls, setups } from "@adapters/persistence/schema";
import { safeHandler } from "@client/api/safeHandler";
import {
  bucketRMultiples,
  buildEquityCurve,
  type ClosedTrade,
} from "@domain/services/aggregateTradeStats";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

const SINCE_DAYS_DEFAULT = 90;

/**
 * Performance API. Aggregates over closed trades (rMultiple IS NOT NULL).
 * Trades without computed metrics (REJECTED, INVALIDATED_PRE_TRADE, ...)
 * are excluded from PnL stats but counted in totals.
 */
export function makePerfApi(deps: { db: DB }) {
  const { db } = deps;

  return {
    perf: safeHandler(async (req) => {
      const url = new URL(req.url);
      const watchId = url.searchParams.get("watchId");
      const sinceDays = Number(url.searchParams.get("sinceDays") ?? SINCE_DAYS_DEFAULT);
      const sinceDate = new Date(Date.now() - sinceDays * 86_400_000);

      const watchFilter = watchId ? eq(setups.watchId, watchId) : undefined;
      const sinceFilter = gte(setups.closedAt, sinceDate);

      // ── KPIs over trades with computed R-multiple ───────────────────────
      const [kpiRow] = await db
        .select({
          tradeCount: sql<number>`count(*)::int`,
          wins: sql<number>`count(*) filter (where ${setups.rMultiple}::numeric > 0)::int`,
          losses: sql<number>`count(*) filter (where ${setups.rMultiple}::numeric < 0)::int`,
          breakeven: sql<number>`count(*) filter (where ${setups.rMultiple}::numeric = 0)::int`,
          totalR: sql<string | null>`sum(${setups.rMultiple}::numeric)`,
          sumPositiveR: sql<
            string | null
          >`sum(${setups.rMultiple}::numeric) filter (where ${setups.rMultiple}::numeric > 0)`,
          sumNegativeR: sql<
            string | null
          >`sum(${setups.rMultiple}::numeric) filter (where ${setups.rMultiple}::numeric < 0)`,
          avgWin: sql<
            string | null
          >`avg(${setups.rMultiple}::numeric) filter (where ${setups.rMultiple}::numeric > 0)`,
          avgLoss: sql<
            string | null
          >`avg(${setups.rMultiple}::numeric) filter (where ${setups.rMultiple}::numeric < 0)`,
          avgPnlPct: sql<string | null>`avg(${setups.pnlPct}::numeric)`,
        })
        .from(setups)
        .where(and(isNotNull(setups.rMultiple), watchFilter, sinceFilter));

      const tradeCount = kpiRow?.tradeCount ?? 0;
      const wins = kpiRow?.wins ?? 0;
      const losses = kpiRow?.losses ?? 0;
      const totalR = num(kpiRow?.totalR);
      const sumPos = num(kpiRow?.sumPositiveR);
      const sumNeg = Math.abs(num(kpiRow?.sumNegativeR));
      const profitFactor = sumNeg > 0 ? sumPos / sumNeg : null;
      const winRate = wins + losses > 0 ? wins / (wins + losses) : null;
      const expectancy = tradeCount > 0 ? totalR / tradeCount : null;

      // ── LLM cost ─────────────────────────────────────────────────────────
      const [costRow] = await db
        .select({
          totalCostUsd: sql<string | null>`coalesce(sum(${llmCalls.costUsd}::numeric), 0)`,
        })
        .from(llmCalls)
        .where(
          and(
            watchId ? eq(llmCalls.watchId, watchId) : undefined,
            gte(llmCalls.occurredAt, sinceDate),
          ),
        );
      const totalCostUsd = num(costRow?.totalCostUsd);

      // ── Equity curve + R-distribution via pure aggregators ──────────────
      const equityRows = await db
        .select({
          closedAt: setups.closedAt,
          r: setups.rMultiple,
        })
        .from(setups)
        .where(and(isNotNull(setups.rMultiple), watchFilter, sinceFilter))
        .orderBy(setups.closedAt);
      const closedTrades: ClosedTrade[] = equityRows.map((row) => ({
        rMultiple: num(row.r),
        closedAt: row.closedAt,
      }));
      const { equityCurve, maxDrawdownR } = buildEquityCurve(closedTrades);
      const rDistribution = bucketRMultiples(closedTrades, 0.5);

      // ── Calibration: score-at-confirmation → observed win rate ──────────
      // We need score from Confirmed event. Use a lateral query.
      const calibRaw = await db.execute(sql`
        SELECT
          floor(s.current_score / 5) * 5 AS score_bucket,
          count(*) FILTER (WHERE s.r_multiple::numeric > 0) AS wins,
          count(*) AS total
        FROM setups s
        WHERE s.r_multiple IS NOT NULL
          ${watchId ? sql`AND s.watch_id = ${watchId}` : sql``}
          AND s.closed_at >= ${sinceDate}
        GROUP BY score_bucket
        ORDER BY score_bucket
      `);
      const calibration = (calibRaw.rows as Array<Record<string, unknown>>).map((row) => ({
        scoreBucket: Number(row.score_bucket),
        observedWinRate: Number(row.total) > 0 ? Number(row.wins) / Number(row.total) : 0,
        count: Number(row.total),
      }));

      // ── Breakdown by pattern × direction ────────────────────────────────
      const byPatternRaw = await db.execute(sql`
        SELECT
          coalesce(s.pattern_hint, '(none)') AS pattern,
          coalesce(s.direction, '?') AS direction,
          count(*) AS trades,
          sum(s.r_multiple::numeric) AS total_r,
          sum(s.r_multiple::numeric) FILTER (WHERE s.r_multiple::numeric > 0) AS sum_pos,
          sum(s.r_multiple::numeric) FILTER (WHERE s.r_multiple::numeric < 0) AS sum_neg,
          count(*) FILTER (WHERE s.r_multiple::numeric > 0) AS wins
        FROM setups s
        WHERE s.r_multiple IS NOT NULL
          ${watchId ? sql`AND s.watch_id = ${watchId}` : sql``}
          AND s.closed_at >= ${sinceDate}
        GROUP BY pattern, direction
        ORDER BY total_r DESC NULLS LAST
      `);
      const byPattern = (byPatternRaw.rows as Array<Record<string, unknown>>).map((row) => {
        const tradesN = Number(row.trades);
        const winsN = Number(row.wins);
        const sumPosN = Number(row.sum_pos ?? 0);
        const sumNegN = Math.abs(Number(row.sum_neg ?? 0));
        return {
          pattern: String(row.pattern),
          direction: String(row.direction),
          trades: tradesN,
          totalR: round(Number(row.total_r ?? 0), 4),
          winRate: tradesN > 0 ? winsN / tradesN : null,
          profitFactor: sumNegN > 0 ? sumPosN / sumNegN : null,
        };
      });

      // ── Cost ROI by stage ───────────────────────────────────────────────
      const costStageRaw = await db.execute(sql`
        SELECT stage, sum(cost_usd::numeric) AS cost_usd
        FROM llm_calls
        WHERE 1=1
          ${watchId ? sql`AND watch_id = ${watchId}` : sql``}
          AND occurred_at >= ${sinceDate}
        GROUP BY stage
        ORDER BY cost_usd DESC
      `);
      const costByStage = (costStageRaw.rows as Array<Record<string, unknown>>).map((row) => ({
        stage: String(row.stage),
        costUsd: round(Number(row.cost_usd ?? 0), 4),
      }));

      return Response.json({
        windowDays: sinceDays,
        kpis: {
          tradeCount,
          wins,
          losses,
          breakeven: kpiRow?.breakeven ?? 0,
          winRate,
          totalR: round(totalR, 4),
          profitFactor: profitFactor !== null ? round(profitFactor, 3) : null,
          expectancy: expectancy !== null ? round(expectancy, 4) : null,
          avgWin: round(num(kpiRow?.avgWin), 4),
          avgLoss: round(num(kpiRow?.avgLoss), 4),
          avgPnlPct: round(num(kpiRow?.avgPnlPct), 3),
          maxDrawdownR: round(maxDrawdownR, 4),
          totalCostUsd: round(totalCostUsd, 4),
        },
        equityCurve,
        rDistribution,
        calibration,
        byPattern,
        costByStage,
      });
    }),
  };
}

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
