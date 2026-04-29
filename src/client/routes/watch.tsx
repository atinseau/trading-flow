import { ConfirmAction } from "@client/components/shared/confirm-action";
import { Button } from "@client/components/ui/button";
import { WatchForm } from "@client/components/watch-form";
import { api } from "@client/lib/api";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

type WatchDetail = {
  id: string;
  enabled: boolean;
  version: number;
  config: WatchConfig;
  state: { lastTickAt: string | null } | null;
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
      nav("/");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (detail.isLoading) return <div>Chargement…</div>;
  if (detail.error || !detail.data) return <div>Erreur</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Watch — {detail.data.id}</h1>
        <ConfirmAction
          title={`Supprimer ${detail.data.id} ?`}
          description="Les workflows Temporal sont arrêtés. Les setups historiques restent en DB."
          trigger={<Button variant="destructive">Supprimer</Button>}
          onConfirm={() => del.mutate()}
          destructive
        />
      </div>
      <WatchForm mode="edit" initial={detail.data.config} onSubmit={(c) => update.mutate(c)} />
    </div>
  );
}
