import { NewSessionModal } from "@client/components/replay/new-session-modal";
import { ReplaySessionCard } from "@client/components/replay/replay-session-card";
import type { ReplaySessionRow, ReplaySessionStatus } from "@client/components/replay/replay-types";
import { Button } from "@client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { Skeleton } from "@client/components/ui/skeleton";
import { useWatches } from "@client/hooks/useWatches";
import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

const STATUSES: { value: ReplaySessionStatus | "all"; label: string }[] = [
  { value: "all", label: "Tous statuts" },
  { value: "READY", label: "READY" },
  { value: "PAUSED", label: "PAUSED" },
  { value: "COMPLETED", label: "COMPLETED" },
  { value: "COST_CAPPED", label: "COST CAPPED" },
  { value: "FAILED", label: "FAILED" },
];

export function Component() {
  const [openModal, setOpenModal] = useState(false);
  const [watchFilter, setWatchFilter] = useState<string>("__all__");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const watches = useWatches();

  const params = new URLSearchParams();
  if (watchFilter !== "__all__") params.set("watchId", watchFilter);
  if (statusFilter !== "all") params.set("status", statusFilter);
  const qs = params.toString();

  const sessions = useQuery({
    queryKey: ["replay", "list", { watchFilter, statusFilter }],
    queryFn: () => api<ReplaySessionRow[]>(`/api/replay/sessions${qs ? `?${qs}` : ""}`),
    staleTime: 5_000,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Replay sessions</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Rétro-exécutions contrôlées de la pipeline sur des fenêtres passées. Chaque session est
            attachée à une watch et utilise sa config réelle ; aucun impact sur la prod.
          </p>
        </div>
        <Button onClick={() => setOpenModal(true)}>
          <Plus className="size-4" />
          Nouvelle session
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={watchFilter} onValueChange={setWatchFilter}>
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
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {sessions.isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      )}

      {sessions.error && (
        <div className="text-sm text-destructive">Erreur : {(sessions.error as Error).message}</div>
      )}

      {sessions.data && sessions.data.length === 0 && (
        <div className="border border-dashed rounded-lg p-12 text-center text-sm text-muted-foreground">
          Aucune session.{" "}
          <button
            type="button"
            className="text-foreground underline"
            onClick={() => setOpenModal(true)}
          >
            En créer une.
          </button>
        </div>
      )}

      {sessions.data && sessions.data.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {sessions.data.map((s) => (
            <ReplaySessionCard key={s.id} session={s} />
          ))}
        </div>
      )}

      <NewSessionModal open={openModal} onClose={() => setOpenModal(false)} />
    </div>
  );
}
