import { Skeleton } from "../ui/skeleton";
import type { PerfKpis } from "./perf-types";

export function PerfKpiTiles({ kpis, loading }: { kpis?: PerfKpis; loading?: boolean }) {
  if (loading || !kpis) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  const sign = (n: number) => (n > 0 ? "+" : "");
  const fmtR = (n: number) => `${sign(n)}${n.toFixed(2)}R`;
  const winRateStr = kpis.winRate === null ? "—" : `${(kpis.winRate * 100).toFixed(0)}%`;
  const pfStr = kpis.profitFactor === null ? "—" : kpis.profitFactor.toFixed(2);
  const expStr =
    kpis.expectancy === null ? "—" : `${sign(kpis.expectancy)}${kpis.expectancy.toFixed(2)}R`;

  // PnL ROI is informational: bot does not auto-trade, so no $ PnL in DB.
  // Display LLM spend alone; cost-per-trade computed inline.
  const costPerTrade = kpis.tradeCount > 0 ? kpis.totalCostUsd / kpis.tradeCount : null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <Tile
        label="Total R"
        value={fmtR(kpis.totalR)}
        positive={kpis.totalR > 0}
        negative={kpis.totalR < 0}
        hint={`${kpis.tradeCount} trades`}
      />
      <Tile
        label="Profit factor"
        value={pfStr}
        positive={kpis.profitFactor !== null && kpis.profitFactor >= 1.5}
        negative={kpis.profitFactor !== null && kpis.profitFactor < 1}
        hint="Σwins / |Σlosses|"
      />
      <Tile
        label="Expectancy"
        value={expStr}
        positive={kpis.expectancy !== null && kpis.expectancy > 0}
        negative={kpis.expectancy !== null && kpis.expectancy < 0}
        hint="moyen / trade"
      />
      <Tile
        label="Win rate"
        value={winRateStr}
        hint={
          kpis.winRate === null
            ? "—"
            : `${kpis.wins}W / ${kpis.losses}L${kpis.breakeven ? ` / ${kpis.breakeven}BE` : ""}`
        }
      />
      <Tile
        label="Max drawdown"
        value={`-${kpis.maxDrawdownR.toFixed(2)}R`}
        negative={kpis.maxDrawdownR > 0}
        hint="peak-to-trough"
      />
      <Tile
        label="Coût LLM"
        value={`$${kpis.totalCostUsd.toFixed(2)}`}
        hint={costPerTrade !== null ? `~$${costPerTrade.toFixed(3)} / trade` : "—"}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  positive,
  negative,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  positive?: boolean;
  negative?: boolean;
}) {
  const tone = positive ? "text-emerald-400" : negative ? "text-red-400" : "text-foreground";
  return (
    <div className="rounded-md border bg-card p-3 space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-lg font-bold font-mono tabular-nums ${tone}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
