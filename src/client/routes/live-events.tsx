import { EventDetailModal } from "@client/components/event-detail-modal";
import { Badge } from "@client/components/ui/badge";
import type { SetupEvent } from "@client/components/setup/events-timeline";
import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

type LiveEvent = SetupEvent & { setupId: string; watchId?: string };

export function Component() {
  const [selected, setSelected] = useState<LiveEvent | null>(null);
  const recent = useQuery({
    queryKey: ["events"],
    queryFn: () => api<LiveEvent[]>("/api/events?limit=200"),
    staleTime: 2_000,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Flux d'événements</h1>
      <div className="space-y-1">
        {(recent.data ?? []).map((e) => (
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
            <span className="ml-auto font-mono text-xs">${Number(e.costUsd ?? 0).toFixed(2)}</span>
            <span className="font-mono w-16 text-right">{Number(e.scoreAfter).toFixed(0)}</span>
          </button>
        ))}
      </div>
      <EventDetailModal event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
