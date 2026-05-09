import { Skeleton } from "@client/components/ui/skeleton";
import type { CostStage } from "./perf-types";

export function CostRoiBars({
  data,
  totalCostUsd,
  loading,
}: {
  data?: CostStage[];
  totalCostUsd?: number;
  loading?: boolean;
}) {
  if (loading) return <Skeleton className="h-[160px]" />;
  if (!data || data.length === 0) {
    return (
      <div className="h-[160px] grid place-items-center rounded-md border bg-card text-sm text-muted-foreground">
        Aucun coût LLM enregistré sur la période.
      </div>
    );
  }
  const total = totalCostUsd ?? data.reduce((s, d) => s + d.costUsd, 0);
  const max = Math.max(...data.map((d) => d.costUsd), 0.0001);

  return (
    <div className="rounded-md border bg-card p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
          Coût LLM par stage
        </h3>
        <div className="text-xs font-mono tabular-nums">${total.toFixed(2)}</div>
      </div>
      <div className="space-y-2">
        {data.map((row) => {
          const pct = (row.costUsd / max) * 100;
          const sharePct = total > 0 ? (row.costUsd / total) * 100 : 0;
          return (
            <div key={row.stage} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono">{row.stage}</span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  ${row.costUsd.toFixed(2)} ({sharePct.toFixed(0)}%)
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-[var(--chart-1)]" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
