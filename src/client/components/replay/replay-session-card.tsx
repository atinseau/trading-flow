import { fmtParisDateTime } from "@client/lib/format";
import { cn } from "@client/lib/utils";
import { Link } from "react-router-dom";
import { Badge } from "../ui/badge";
import type { ReplaySessionRow, ReplaySessionStatus } from "./replay-types";

const STATUS_BADGE: Record<ReplaySessionStatus, { label: string; class: string }> = {
  READY: {
    label: "READY",
    class: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  },
  PAUSED: {
    label: "PAUSED",
    class: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  COMPLETED: {
    label: "COMPLETED",
    class: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  },
  COST_CAPPED: {
    label: "COST CAPPED",
    class: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  },
  FAILED: {
    label: "FAILED",
    class: "bg-red-500/15 text-red-300 border-red-500/30",
  },
};

function fmtDate(iso: string): string {
  return fmtParisDateTime(iso);
}

function fmtCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function ReplaySessionCard({ session }: { session: ReplaySessionRow }) {
  const meta = STATUS_BADGE[session.status];
  return (
    <Link
      to={`/replay/${session.id}`}
      className="rounded-md border bg-card p-4 hover:bg-card/80 transition-colors flex flex-col gap-2"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-sm">
          {session.name ?? `Session ${session.id.slice(0, 8)}`}
        </div>
        <Badge variant="outline" className={cn("text-[10px]", meta.class)}>
          {meta.label}
        </Badge>
      </div>
      <div className="text-xs text-muted-foreground font-mono">
        {session.watchId} · {fmtDate(session.windowStartAt)} → {fmtDate(session.windowEndAt)}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Coût {fmtCost(session.costUsdSoFar)} / {fmtCost(session.costCapUsd)}
        </span>
        <span>{fmtDate(session.createdAt)}</span>
      </div>
      <div className="text-[10px] text-muted-foreground/70 font-mono">
        lessons={session.lessonsMode} · feedback={session.feedbackMode}
      </div>
    </Link>
  );
}
