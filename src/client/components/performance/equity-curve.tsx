import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@client/components/ui/chart";
import { Skeleton } from "@client/components/ui/skeleton";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import type { EquityPoint } from "./perf-types";

const config = {
  cumulativeR: { label: "Cumulé R", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function EquityCurve({ data, loading }: { data?: EquityPoint[]; loading?: boolean }) {
  if (loading) return <Skeleton className="h-[280px]" />;
  if (!data || data.length === 0) {
    return (
      <div className="h-[280px] grid place-items-center rounded-md border bg-card text-sm text-muted-foreground">
        Aucun trade clôturé sur la période — pas d'equity curve à afficher.
      </div>
    );
  }
  // Index points by 1-based ordinal so x-axis is monotonic regardless of
  // null closedAt values.
  const points = data.map((p, i) => ({
    x: i + 1,
    cumulativeR: p.cumulativeR,
    closedAt: p.closedAt,
  }));
  const lastR = points[points.length - 1]?.cumulativeR ?? 0;
  const positive = lastR >= 0;
  const stroke = positive ? "var(--chart-2)" : "var(--chart-3)";

  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
          Equity curve (cumulé R)
        </h3>
        <div
          className={`text-xs font-mono tabular-nums ${positive ? "text-emerald-400" : "text-red-400"}`}
        >
          {positive ? "+" : ""}
          {lastR.toFixed(2)}R sur {points.length} trades
        </div>
      </div>
      <ChartContainer config={config} className="h-[240px] w-full">
        <AreaChart data={points} margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={stroke} stopOpacity={0.4} />
              <stop offset="95%" stopColor={stroke} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis
            dataKey="x"
            tickLine={false}
            axisLine={false}
            fontSize={10}
            tickFormatter={(v) => `#${v}`}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            fontSize={10}
            width={40}
            tickFormatter={(v) => `${v > 0 ? "+" : ""}${v}R`}
          />
          <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="3 3" />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Area
            type="monotone"
            dataKey="cumulativeR"
            stroke={stroke}
            strokeWidth={2}
            fill="url(#equityFill)"
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
