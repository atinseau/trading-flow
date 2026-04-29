import { Badge } from "@client/components/ui/badge";
import { useState } from "react";

export type SetupEvent = {
  id: string;
  sequence: number;
  occurredAt: string;
  type: string;
  scoreDelta: string;
  scoreAfter: string;
  statusBefore: string;
  statusAfter: string;
  payload: {
    type: string;
    data: {
      reasoning?: string;
      observations?: string[];
      freshDataSummary?: { lastClose: number; candlesSinceCreation: number };
    };
  };
  provider: string | null;
  model: string | null;
  costUsd: string | null;
  latencyMs: number | null;
};

const variantFor = (type: string): "default" | "secondary" | "destructive" => {
  if (["Strengthened", "Confirmed", "TPHit", "EntryFilled"].includes(type)) return "default";
  if (
    ["Weakened", "Invalidated", "Rejected", "SLHit", "Expired", "PriceInvalidated"].includes(type)
  )
    return "destructive";
  return "secondary";
};

export function EventsTimeline({ events }: { events: SetupEvent[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      {events.map((e) => {
        const open = openId === e.id;
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => setOpenId(open ? null : e.id)}
            className={`w-full text-left border-b border-border py-2 cursor-pointer ${
              open ? "bg-card -mx-2 px-2 rounded" : ""
            }`}
          >
            <div className="flex items-center gap-3 text-xs">
              <span className="text-muted-foreground font-mono">
                {new Date(e.occurredAt).toLocaleTimeString("fr-FR", { hour12: false })}
              </span>
              <Badge variant={variantFor(e.type)}>{e.type}</Badge>
              <span className="font-mono ml-auto">
                {Number(e.scoreDelta) !== 0 && (Number(e.scoreDelta) > 0 ? "+" : "")}
                {Number(e.scoreDelta) !== 0 ? Number(e.scoreDelta).toFixed(0) : ""}
                {" → "}
                {Number(e.scoreAfter).toFixed(0)}
              </span>
            </div>
            {e.provider && (
              <div className="text-[10px] text-muted-foreground font-mono mt-1 ml-1">
                {e.provider} · {e.model} · ${Number(e.costUsd ?? 0).toFixed(2)} · {e.latencyMs}ms
              </div>
            )}
            {open && e.payload?.data?.reasoning && (
              <div className="mt-2 p-3 bg-background rounded border border-primary/30 text-xs space-y-2">
                <div>
                  <p className="font-bold text-muted-foreground uppercase tracking-wide text-[10px] mb-1">
                    Raisonnement
                  </p>
                  <p className="text-foreground/90 leading-relaxed">{e.payload.data.reasoning}</p>
                </div>
                {e.payload.data.observations && e.payload.data.observations.length > 0 && (
                  <div>
                    <p className="font-bold text-muted-foreground uppercase tracking-wide text-[10px] mb-1">
                      Observations
                    </p>
                    <ul className="space-y-1">
                      {e.payload.data.observations.map((o, i) => (
                        <li key={i} className="border-l-2 border-primary pl-2 text-[11px]">{o}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {e.payload.data.freshDataSummary && (
                  <div>
                    <p className="font-bold text-muted-foreground uppercase tracking-wide text-[10px] mb-1">
                      Données fraîches
                    </p>
                    <p className="font-mono text-[11px]">
                      Last close: {e.payload.data.freshDataSummary.lastClose} · Candles since creation:{" "}
                      {e.payload.data.freshDataSummary.candlesSinceCreation}
                    </p>
                  </div>
                )}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
