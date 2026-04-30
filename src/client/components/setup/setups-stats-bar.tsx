import { Skeleton } from "../ui/skeleton";

export type SetupsStats = {
  total: number;
  live: number;
  wins: number;
  losses: number;
  other: number;
  winRate: number | null;
  avgScoreAtConfirmation: number | null;
  totalCostUsd: number;
};

export function SetupsStatsBar({ stats, loading }: { stats?: SetupsStats; loading?: boolean }) {
  if (loading || !stats) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {["total", "live", "wins", "losses", "winRate", "cost"].map((k) => (
          <Skeleton key={k} className="h-16" />
        ))}
      </div>
    );
  }

  const Cell = ({
    label,
    value,
    hint,
  }: {
    label: string;
    value: React.ReactNode;
    hint?: string;
  }) => (
    <div className="rounded-md border bg-card p-3 space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-bold font-mono tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <Cell label="Total" value={stats.total} />
      <Cell label="Live" value={stats.live} />
      <Cell label="Wins" value={stats.wins} hint="WIN + PARTIAL_WIN" />
      <Cell label="Losses" value={stats.losses} />
      <Cell
        label="Win rate"
        value={stats.winRate === null ? "—" : `${(stats.winRate * 100).toFixed(0)}%`}
        hint={
          stats.winRate === null
            ? "pas de trade clôturé"
            : `${stats.wins} / ${stats.wins + stats.losses}`
        }
      />
      <Cell
        label="Coût LLM"
        value={`$${stats.totalCostUsd.toFixed(2)}`}
        hint={
          stats.avgScoreAtConfirmation !== null
            ? `score conf. moy. ${stats.avgScoreAtConfirmation.toFixed(0)}`
            : undefined
        }
      />
    </div>
  );
}
