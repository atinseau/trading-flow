import { cn } from "@client/lib/utils";
import { colorForSetup } from "./replay-marker-config";
import type { ReplayEventRow } from "./replay-types";

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function shortReason(e: ReplayEventRow): string {
  const payload = e.payload as { data?: unknown };
  const data = payload.data as
    | { reasoning?: string; ignoreReason?: string | null; reason?: string; level?: number }
    | undefined;
  if (data?.reasoning) return data.reasoning;
  if (data?.ignoreReason) return data.ignoreReason;
  if (data?.reason) return data.reason;
  if (typeof data?.level === "number") return `level ${data.level}`;
  return "";
}

export function DecisionsLog(props: {
  events: ReplayEventRow[];
  activeSetupId: string | null;
  focusedEventId: string | null;
  onFocus: (eventId: string) => void;
}) {
  const filtered = props.activeSetupId
    ? props.events.filter((e) => e.setupId === props.activeSetupId)
    : props.events;

  if (filtered.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        Aucun event pour le filtre courant.
      </div>
    );
  }

  return (
    <ul className="space-y-0.5 text-xs font-mono">
      {filtered.map((e) => {
        const focused = props.focusedEventId === e.id;
        const setupColor = colorForSetup(e.setupId);
        const delta = e.scoreDelta;
        const deltaStr = delta === 0 ? "" : delta > 0 ? `+${delta}` : `${delta}`;
        const deltaCls =
          delta > 0 ? "text-emerald-400" : delta < 0 ? "text-red-400" : "text-muted-foreground";
        const reason = shortReason(e);
        return (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => props.onFocus(e.id)}
              className={cn(
                "w-full rounded px-2 py-1 text-left transition-colors flex items-start gap-2",
                focused ? "bg-primary/10 border border-primary/30" : "hover:bg-card",
              )}
            >
              <span
                className="inline-block size-2 rounded-full shrink-0 mt-1"
                style={{ backgroundColor: setupColor }}
              />
              <span className="text-muted-foreground shrink-0 w-32">{fmtTime(e.occurredAt)}</span>
              <span className="shrink-0 w-20">{e.stage}</span>
              <span className="shrink-0 w-32">{e.type}</span>
              {deltaStr && (
                <span className={cn("shrink-0 w-12 tabular-nums", deltaCls)}>{deltaStr}</span>
              )}
              <span className="truncate text-muted-foreground">{reason}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
