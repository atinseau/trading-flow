import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { MarketStateBadge } from "../components/market-state-badge";
import { SetupsListSection } from "../components/setup/setups-list-section";
import { ConfirmAction } from "../components/shared/confirm-action";
import { Button } from "../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { WatchForm } from "../components/watch-form";
import { api } from "../lib/api";
import { fmtRelative } from "../lib/format";

type WatchDetail = {
  id: string;
  enabled: boolean;
  version: number;
  config: WatchConfig;
  state: {
    lastTickAt: string | null;
    totalCostUsdMtd: string;
    setupsCreatedMtd: number;
    setupsConfirmedMtd: number;
  } | null;
};

export function Component() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: ["watches", id],
    queryFn: () => api<WatchDetail>(`/api/watches/${id}`),
  });

  const update = useMutation({
    mutationFn: (config: WatchConfig) =>
      api(`/api/watches/${id}`, {
        method: "PUT",
        body: JSON.stringify({ config, version: detail.data!.version }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      qc.invalidateQueries({ queryKey: ["watches", id] });
      toast.success("Watch mise à jour");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const del = useMutation({
    mutationFn: () => api(`/api/watches/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      toast.success("Watch supprimée");
      nav("/watches");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (detail.isLoading) return <div>Chargement…</div>;
  if (detail.error || !detail.data) return <div>Erreur</div>;

  const watch = detail.data;
  const cfg = watch.config;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-3">
            <span className="font-mono">{watch.id}</span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${watch.enabled ? "bg-emerald-500/15 text-emerald-400" : "bg-zinc-500/15 text-zinc-400"}`}
            >
              {watch.enabled ? "Active" : "Pause"}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1 font-mono">
            {cfg.asset.symbol} · {cfg.timeframes.primary} · {cfg.asset.source}
            {watch.state?.lastTickAt && <> · dernier tick {fmtRelative(watch.state.lastTickAt)}</>}
          </p>
          <div className="flex gap-2 mt-2">
            <MarketStateBadge watch={{ asset: cfg.asset }} />
          </div>
        </div>
        <ConfirmAction
          title={`Supprimer ${watch.id} ?`}
          description="Les workflows Temporal sont arrêtés. Les setups historiques restent en DB."
          trigger={<Button variant="destructive">Supprimer</Button>}
          onConfirm={() => del.mutate()}
          destructive
        />
      </div>

      <Tabs defaultValue="setups">
        <TabsList>
          <TabsTrigger value="setups">Setups</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
        </TabsList>

        <TabsContent value="setups" className="mt-6">
          <SetupsListSection watchId={watch.id} />
        </TabsContent>

        <TabsContent value="config" className="mt-6">
          <WatchForm mode="edit" initial={cfg} onSubmit={(c) => update.mutate(c)} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
