import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

type EventRow = { id: string; setupId: string; watchId?: string; type: string };
type TickRow = { watchId: string };

export function useSSEStream(): void {
  const qc = useQueryClient();

  useEffect(() => {
    const sse = new EventSource("/api/stream?topics=events,setups,watches,ticks");

    sse.addEventListener("events", (e: MessageEvent) => {
      const evt = JSON.parse(e.data) as EventRow;
      qc.setQueryData<EventRow[]>(["events", "live"], (old = []) => [evt, ...old].slice(0, 100));
      qc.invalidateQueries({ queryKey: ["setups", evt.setupId] });
      qc.invalidateQueries({ queryKey: ["setups", evt.setupId, "events"] });
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["costs"] });
    });

    sse.addEventListener("setups", () => {
      qc.invalidateQueries({ queryKey: ["setups"] });
    });

    sse.addEventListener("watches", () => {
      qc.invalidateQueries({ queryKey: ["watches"] });
    });

    sse.addEventListener("ticks", (e: MessageEvent) => {
      const tick = JSON.parse(e.data) as TickRow;
      qc.invalidateQueries({ queryKey: ["ticks", tick.watchId] });
      qc.invalidateQueries({ queryKey: ["watches"] });
    });

    return () => sse.close();
  }, [qc]);
}
