import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@client/components/ui/chart";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

const chartConfig = {
  score: { label: "Score", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function ScoreChart(props: { points: { occurredAt: string; scoreAfter: number }[] }) {
  const data = props.points.map((p) => ({
    time: new Date(p.occurredAt).toLocaleTimeString(),
    score: p.scoreAfter,
  }));
  return (
    <ChartContainer config={chartConfig} className="h-[120px] w-full">
      <LineChart data={data} margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.2} />
        <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={10} />
        <YAxis domain={[0, 100]} tickLine={false} axisLine={false} fontSize={10} width={28} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line
          type="monotone"
          dataKey="score"
          stroke="var(--color-score)"
          strokeWidth={2}
          dot={{ r: 3 }}
        />
      </LineChart>
    </ChartContainer>
  );
}
