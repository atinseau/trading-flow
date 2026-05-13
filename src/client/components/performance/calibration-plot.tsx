import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@client/components/ui/chart";
import { Skeleton } from "@client/components/ui/skeleton";
import { CartesianGrid, ReferenceLine, Scatter, ScatterChart, XAxis, YAxis, ZAxis } from "recharts";
import type { CalibrationPoint } from "./perf-types";

const config = {
  observedWinRate: { label: "Win rate observé", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function CalibrationPlot({
  data,
  loading,
}: {
  data?: CalibrationPoint[];
  loading?: boolean;
}) {
  if (loading) return <Skeleton className="h-[260px]" />;
  if (!data || data.length === 0) {
    return (
      <div className="h-[260px] grid place-items-center rounded-md border bg-card text-sm text-muted-foreground">
        Pas assez de trades pour la calibration.
      </div>
    );
  }
  // Convert to percentage scale on Y axis to match score's 0-100 X axis.
  const points = data.map((p) => ({
    score: p.scoreBucket,
    winRatePct: p.observedWinRate * 100,
    count: p.count,
  }));
  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
          Calibration : score → win rate observé
        </h3>
        <div className="text-[10px] text-muted-foreground">diagonale = parfaite calibration</div>
      </div>
      <ChartContainer config={config} className="h-[220px] w-full">
        <ScatterChart margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
          <CartesianGrid strokeOpacity={0.15} />
          <XAxis
            dataKey="score"
            type="number"
            domain={[0, 100]}
            tickLine={false}
            axisLine={false}
            fontSize={10}
            tickFormatter={(v) => `${v}`}
            label={{ value: "Score", position: "insideBottom", offset: -2, fontSize: 10 }}
          />
          <YAxis
            dataKey="winRatePct"
            type="number"
            domain={[0, 100]}
            tickLine={false}
            axisLine={false}
            fontSize={10}
            width={36}
            tickFormatter={(v) => `${v}%`}
          />
          <ZAxis dataKey="count" range={[40, 300]} />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 100, y: 100 },
            ]}
            stroke="var(--border)"
            strokeDasharray="3 3"
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Scatter data={points} fill="var(--chart-1)" />
        </ScatterChart>
      </ChartContainer>
    </div>
  );
}
