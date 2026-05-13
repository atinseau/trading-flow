import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@client/components/ui/chart";
import { Skeleton } from "@client/components/ui/skeleton";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, XAxis, YAxis } from "recharts";
import type { RBucket } from "./perf-types";

const config = {
  count: { label: "Trades", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function RDistribution({ data, loading }: { data?: RBucket[]; loading?: boolean }) {
  if (loading) return <Skeleton className="h-[260px]" />;
  if (!data || data.length === 0) {
    return (
      <div className="h-[260px] grid place-items-center rounded-md border bg-card text-sm text-muted-foreground">
        Pas assez de trades pour la distribution.
      </div>
    );
  }
  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
        Distribution R-multiple (buckets 0.5R)
      </h3>
      <ChartContainer config={config} className="h-[220px] w-full">
        <BarChart data={data} margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis
            dataKey="bucket"
            tickLine={false}
            axisLine={false}
            fontSize={10}
            tickFormatter={(v) => `${v > 0 ? "+" : ""}${v}R`}
          />
          <YAxis tickLine={false} axisLine={false} fontSize={10} width={28} />
          <ReferenceLine x={0} stroke="var(--border)" strokeDasharray="3 3" />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="count">
            {data.map((d) => (
              <Cell key={d.bucket} fill={d.bucket >= 0 ? "var(--chart-2)" : "var(--chart-3)"} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  );
}
