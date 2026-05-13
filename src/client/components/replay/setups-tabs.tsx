import { cn } from "@client/lib/utils";
import { colorForSetup } from "./replay-marker-config";
import type { SetupProjectionRow } from "./replay-types";

export function SetupsTabs(props: {
  setups: SetupProjectionRow[];
  activeSetupId: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        onClick={() => props.onChange(null)}
        className={cn(
          "px-3 py-1 rounded-full border transition-colors",
          props.activeSetupId === null
            ? "bg-primary text-primary-foreground border-primary"
            : "border-border hover:bg-card",
        )}
      >
        Tous ({props.setups.length})
      </button>
      {props.setups.map((s) => {
        const active = props.activeSetupId === s.setupId;
        const color = colorForSetup(s.setupId);
        return (
          <button
            key={s.setupId}
            type="button"
            onClick={() => props.onChange(s.setupId)}
            className={cn(
              "px-3 py-1 rounded-full border transition-colors inline-flex items-center gap-1",
              active
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border hover:bg-card",
            )}
            title={s.setupId}
          >
            <span className="inline-block size-2 rounded-full" style={{ backgroundColor: color }} />
            {s.direction ?? "?"} {s.patternHint ?? "setup"} ({s.setupId.slice(0, 6)})
          </button>
        );
      })}
    </div>
  );
}
