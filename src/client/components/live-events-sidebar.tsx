import { EventDetailModal } from "@client/components/event-detail-modal";
import type { SetupEvent } from "@client/components/setup/events-timeline";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

type LiveEvent = SetupEvent & { setupId: string; watchId?: string };

export function LiveEventsSidebar() {
  const { data = [] } = useQuery<LiveEvent[]>({
    queryKey: ["events", "live"],
    queryFn: async () => [],
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [selected, setSelected] = useState<LiveEvent | null>(null);

  return (
    <div className="text-xs space-y-1">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        Live events
      </h4>
      {data.length === 0 && (
        <p className="text-muted-foreground italic">En attente d'événements…</p>
      )}
      {data.map((e) => (
        <button
          key={e.id}
          type="button"
          onClick={() => setSelected(e)}
          className="w-full text-left border-b border-dashed border-border py-2 hover:bg-card rounded px-1"
        >
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground font-mono text-[10px]">
              {new Date(e.occurredAt).toLocaleTimeString("fr-FR", { hour12: false })}
            </span>
            {e.watchId && <span className="text-primary font-mono text-[10px]">{e.watchId}</span>}
            <span className="font-bold">{e.type}</span>
            <span className="ml-auto font-mono">{Number(e.scoreAfter).toFixed(0)}</span>
          </div>
        </button>
      ))}
      <EventDetailModal event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
