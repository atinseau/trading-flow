import { Badge } from "@client/components/ui/badge";
import { cn } from "@client/lib/utils";
import { colorForSetup } from "./replay-marker-config";
import type { SetupProjectionRow } from "./replay-types";

const TERMINAL = new Set(["CLOSED", "INVALIDATED", "EXPIRED", "REJECTED", "KILLED"]);

function rMultipleLabel(r: number | null): string {
  if (r === null) return "—";
  const sign = r > 0 ? "+" : "";
  return `${sign}${r.toFixed(2)}R`;
}

function rMultipleTone(r: number | null): string {
  if (r === null || r === 0) return "text-muted-foreground";
  return r > 0 ? "text-emerald-400" : "text-red-400";
}

export function AliveSetupsList(props: {
  setups: SetupProjectionRow[];
  activeSetupId: string | null;
  onPick: (id: string | null) => void;
}) {
  if (props.setups.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        Aucun setup détecté pour le moment.
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {props.setups.map((s) => {
        const active = props.activeSetupId === s.setupId;
        const terminal = TERMINAL.has(s.status);
        const color = colorForSetup(s.setupId);
        return (
          <li key={s.setupId}>
            <button
              type="button"
              onClick={() => props.onPick(active ? null : s.setupId)}
              className={cn(
                "w-full rounded border bg-card p-2 text-left text-xs transition-colors",
                active ? "border-primary bg-primary/10" : "border-border hover:bg-card/80",
                terminal && "opacity-70",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="inline-flex items-center gap-2 font-mono">
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span>{s.direction ?? "?"}</span>
                  <span>{s.patternHint ?? "—"}</span>
                  <span className="text-muted-foreground/70">#{s.setupId.slice(0, 6)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {s.status}
                  </Badge>
                  {terminal ? (
                    <span className={cn("font-mono tabular-nums", rMultipleTone(s.rMultiple))}>
                      {rMultipleLabel(s.rMultiple)}
                    </span>
                  ) : (
                    <span className="font-mono tabular-nums">{s.currentScore.toFixed(0)}/100</span>
                  )}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
