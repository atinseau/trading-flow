import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EventDetailModal } from "../components/event-detail-modal";
import type { SetupEvent } from "../components/setup/events-timeline";
import { Badge } from "../components/ui/badge";
import { api } from "../lib/api";

type LiveEvent = SetupEvent & { setupId: string; watchId?: string };

export function Component() {
  const [selected, setSelected] = useState<LiveEvent | null>(null);
  const recent = useQuery({
    queryKey: ["events"],
    queryFn: () => api<LiveEvent[]>("/api/events?limit=200"),
    staleTime: 2_000,
  });

  const items = recent.data ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Flux d'événements</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Cycle de vie des setups (création, renforcement, affaiblissement, confirmation,
          invalidation). Mis à jour en temps réel quand un workflow tick.
        </p>
      </div>

      {recent.isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Chargement…</div>
      ) : recent.error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Erreur de chargement : {(recent.error as Error).message}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
          <p>Aucun événement pour le moment.</p>
          <p className="mt-2 text-xs">
            Les événements apparaissent quand un setup est <strong>créé</strong>,{" "}
            <strong>renforcé/affaibli</strong>, <strong>confirmé</strong>, <strong>invalidé</strong>
            , ou <strong>expiré</strong>. Force un tick depuis une watch pour en générer.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {items.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setSelected(e)}
              className="w-full text-left flex items-center gap-3 border-b border-border py-2 hover:bg-card rounded px-2 text-sm"
            >
              <span className="text-muted-foreground font-mono text-xs w-24">
                {new Date(e.occurredAt).toLocaleString("fr-FR")}
              </span>
              <Badge variant="secondary" className="w-24 justify-center font-mono">
                {e.watchId}
              </Badge>
              <span className="font-bold w-32">{e.type}</span>
              <span className="text-muted-foreground text-xs">
                {e.provider} · {e.model}
              </span>
              <span className="font-mono w-16 ml-auto text-right">
                {Number(e.scoreAfter).toFixed(0)}
              </span>
            </button>
          ))}
        </div>
      )}

      <EventDetailModal event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
