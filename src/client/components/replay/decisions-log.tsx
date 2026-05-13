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
              {/* Each fixed-width column also needs `truncate` (not just
                  `w-*`) — otherwise overflowing content visually bleeds
                  onto the next column even though the layout box itself
                  is the right width. */}
              <span className="text-muted-foreground shrink-0 w-32 truncate">
                {fmtTime(e.occurredAt)}
              </span>
              <span className="shrink-0 w-20 truncate">{e.stage}</span>
              <span className="shrink-0 w-44 truncate" title={e.type}>
                {e.type}
              </span>
              {deltaStr && (
                <span className={cn("shrink-0 w-12 tabular-nums", deltaCls)}>{deltaStr}</span>
              )}
              {/* min-w-0 is required so flex doesn't grant this span its
                  natural content width — without it, a long `reason` blows
                  the row past the parent column and the rest of the UI
                  reflows horizontally. */}
              <span className="truncate text-muted-foreground min-w-0 flex-1" title={reason}>
                {reason}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
