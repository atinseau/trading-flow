import { Link } from "react-router-dom";
import { liveBadgeClass, outcomeMeta } from "../../lib/outcome";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

export type SetupListItem = {
  id: string;
  watchId: string;
  asset: string;
  timeframe: string;
  status: string;
  currentScore: string;
  patternHint: string | null;
  direction: "LONG" | "SHORT" | null;
  outcome: string | null;
  ttlExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

const ACTIVE = new Set(["CANDIDATE", "REVIEWING", "FINALIZING", "TRACKING"]);

function formatDuration(fromIso: string, toIso: string | null): string {
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  const ms = Math.max(0, to - from);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}j`;
}

export function SetupCard({ setup }: { setup: SetupListItem }) {
  const live = ACTIVE.has(setup.status);
  const meta = outcomeMeta(setup.outcome);
  const accent = meta?.border ?? (live ? "border-l-blue-500" : "border-l-border");
  const badgeClass = meta ? meta.badge : live ? liveBadgeClass() : "";
  const badgeLabel = meta ? meta.short : live ? "LIVE" : setup.status;

  return (
    <Link
      to={`/setups/${setup.id}`}
      className={cn(
        "block rounded-md border border-l-4 bg-card hover:bg-accent transition-colors p-3 space-y-2",
        accent,
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono font-bold">{setup.asset}</span>
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-xs text-muted-foreground">{setup.timeframe}</span>
        {setup.direction && (
          <Badge
            variant={setup.direction === "LONG" ? "default" : "destructive"}
            className="text-[10px]"
          >
            {setup.direction}
          </Badge>
        )}
        {setup.patternHint && (
          <span className="text-xs text-muted-foreground truncate">{setup.patternHint}</span>
        )}
        <Badge variant="outline" className={cn("ml-auto text-[10px] uppercase", badgeClass)}>
          {badgeLabel}
        </Badge>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground font-mono">
        <span>score {Number(setup.currentScore).toFixed(0)}</span>
        <span>·</span>
        <span>{formatDuration(setup.createdAt, setup.closedAt)}</span>
        <span>·</span>
        <span className="truncate">{setup.watchId}</span>
      </div>
    </Link>
  );
}
