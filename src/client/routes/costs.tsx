import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { api } from "../lib/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

type Aggregation = { key: string; totalUsd: number; count: number };

const config = {
  totalUsd: { label: "USD", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function Component() {
  const [groupBy, setGroupBy] = useState<"watch" | "provider" | "model" | "day">("watch");

  const { data = [] } = useQuery({
    queryKey: ["costs", { groupBy }],
    queryFn: () => api<Aggregation[]>(`/api/costs?groupBy=${groupBy}`),
    staleTime: 60_000,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Coûts LLM</h1>
      <Tabs value={groupBy} onValueChange={(v) => setGroupBy(v as typeof groupBy)}>
        <TabsList>
          <TabsTrigger value="watch">Par watch</TabsTrigger>
          <TabsTrigger value="provider">Par provider</TabsTrigger>
          <TabsTrigger value="model">Par modèle</TabsTrigger>
          <TabsTrigger value="day">Par jour</TabsTrigger>
        </TabsList>
      </Tabs>
      <ChartContainer config={config} className="h-[300px] w-full">
        <BarChart data={data}>
          <CartesianGrid vertical={false} strokeOpacity={0.2} />
          <XAxis dataKey="key" fontSize={11} />
          <YAxis fontSize={11} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="totalUsd" fill="var(--color-totalUsd)" radius={4} />
        </BarChart>
      </ChartContainer>
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground text-xs">
          <tr>
            <th className="py-2">Clé</th>
            <th>Total</th>
            <th>Calls</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.key} className="border-t border-border">
              <td className="py-2 font-mono">{row.key}</td>
              <td className="font-mono">${row.totalUsd.toFixed(2)}</td>
              <td className="font-mono">{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
