import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@client/components/ui/dialog";
import type { SetupEvent } from "@client/components/setup/events-timeline";
import { Link } from "react-router-dom";

export function EventDetailModal(props: {
  event: (SetupEvent & { setupId: string; watchId?: string }) | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!props.event} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {props.event?.type} —{" "}
            {props.event && new Date(props.event.occurredAt).toLocaleString("fr-FR")}
          </DialogTitle>
        </DialogHeader>
        {props.event && (
          <div className="space-y-4 text-sm">
            <p className="font-mono text-xs">
              {props.event.provider} · {props.event.model} · ${Number(props.event.costUsd ?? 0).toFixed(2)} ·{" "}
              {props.event.latencyMs}ms
            </p>
            <p>
              Score : <span className="font-mono">{Number(props.event.scoreAfter).toFixed(0)}</span>
              {Number(props.event.scoreDelta) !== 0 && (
                <span className="text-muted-foreground ml-2">
                  ({Number(props.event.scoreDelta) > 0 ? "+" : ""}
                  {Number(props.event.scoreDelta).toFixed(0)})
                </span>
              )}
            </p>
            {props.event.payload?.data?.reasoning && (
              <div>
                <p className="font-bold text-xs uppercase text-muted-foreground mb-1">Raisonnement</p>
                <p className="leading-relaxed">{props.event.payload.data.reasoning}</p>
              </div>
            )}
            {props.event.payload?.data?.observations &&
              props.event.payload.data.observations.length > 0 && (
                <div>
                  <p className="font-bold text-xs uppercase text-muted-foreground mb-1">Observations</p>
                  <ul className="space-y-1">
                    {props.event.payload.data.observations.map((o, i) => (
                      <li key={i} className="border-l-2 border-primary pl-2">{o}</li>
                    ))}
                  </ul>
                </div>
              )}
            <Link
              to={`/setups/${props.event.setupId}`}
              className="text-primary text-xs hover:underline block"
              onClick={props.onClose}
            >
              Voir le setup complet →
            </Link>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
