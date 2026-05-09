import { CalibrationPlot } from "@client/components/performance/calibration-plot";
import { CostRoiBars } from "@client/components/performance/cost-roi-bars";
import { EquityCurve } from "@client/components/performance/equity-curve";
import { PatternBreakdown } from "@client/components/performance/pattern-breakdown";
import { PerfKpiTiles } from "@client/components/performance/perf-kpi-tiles";
import type { PerfResponse } from "@client/components/performance/perf-types";
import { RDistribution } from "@client/components/performance/r-distribution";
import { SignificanceBanner } from "@client/components/performance/significance-banner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { useWatches } from "@client/hooks/useWatches";
import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

const WINDOWS = [
  { value: 7, label: "7 jours" },
  { value: 30, label: "30 jours" },
  { value: 90, label: "90 jours" },
  { value: 365, label: "1 an" },
];

export function Component() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialWatchId = searchParams.get("watchId") ?? "__all__";
  const [watchId, setWatchIdState] = useState<string>(initialWatchId);
  const [windowDays, setWindowDays] = useState(30);
  const watches = useWatches();

  const setWatchId = (next: string) => {
    setWatchIdState(next);
    const sp = new URLSearchParams(searchParams);
    if (next === "__all__") sp.delete("watchId");
    else sp.set("watchId", next);
    setSearchParams(sp, { replace: true });
  };

  const params = new URLSearchParams();
  if (watchId !== "__all__") params.set("watchId", watchId);
  params.set("sinceDays", String(windowDays));
  const qs = params.toString();

  const perf = useQuery({
    queryKey: ["perf", { watchId, windowDays }],
    queryFn: () => api<PerfResponse>(`/api/perf?${qs}`),
    staleTime: 30_000,
  });

  if (perf.error) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
        Erreur de chargement de la perf : {(perf.error as Error).message}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Performance</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Métriques agrégées sur les trades clôturés (entry filled). Les setups REJECTED ou
            invalidés avant entry ne sont pas comptés en PnL.
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={watchId} onValueChange={setWatchId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Toutes les watches</SelectItem>
              {watches.data?.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(windowDays)} onValueChange={(v) => setWindowDays(Number(v))}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((w) => (
                <SelectItem key={w.value} value={String(w.value)}>
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {perf.data && <SignificanceBanner tradeCount={perf.data.kpis.tradeCount} />}

      <PerfKpiTiles kpis={perf.data?.kpis} loading={perf.isLoading} />

      <EquityCurve data={perf.data?.equityCurve} loading={perf.isLoading} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RDistribution data={perf.data?.rDistribution} loading={perf.isLoading} />
        <CalibrationPlot data={perf.data?.calibration} loading={perf.isLoading} />
      </div>

      <PatternBreakdown data={perf.data?.byPattern} loading={perf.isLoading} />

      <CostRoiBars
        data={perf.data?.costByStage}
        totalCostUsd={perf.data?.kpis.totalCostUsd}
        loading={perf.isLoading}
      />
    </div>
  );
}
