import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { SetupLessonsSpotlight } from "../components/lessons/setup-lessons-spotlight";
import type { SetupEvent } from "../components/setup/events-timeline";
import { KeyLevels } from "../components/setup/key-levels";
import { NarrativeTimeline } from "../components/setup/narrative-timeline";
import { type Candle, type Level, TVChart } from "../components/setup/tv-chart";
import { ConfirmAction } from "../components/shared/confirm-action";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useAdminAction } from "../hooks/useAdminAction";
import { api } from "../lib/api";
import { liveBadgeClass, outcomeMeta } from "../lib/outcome";
import { cn } from "../lib/utils";

type Setup = {
  id: string;
  watchId: string;
  asset: string;
  timeframe: string;
  status: string;
  currentScore: string;
  patternHint: string | null;
  direction: "LONG" | "SHORT" | null;
  invalidationLevel: string | null;
  ttlExpiresAt: string;
  outcome: string | null;
  createdAt: string;
  closedAt: string | null;
};

const ACTIVE = new Set(["CANDIDATE", "REVIEWING", "FINALIZING", "TRACKING"]);

function fmtDuration(fromIso: string, toIso: string | null): string {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}j`;
}

export function Component() {
  const { id } = useParams<{ id: string }>();
  const { killSetup, forceTick } = useAdminAction();

  const setup = useQuery({
    queryKey: ["setups", id],
    queryFn: () => api<Setup>(`/api/setups/${id}`),
  });
  const events = useQuery({
    queryKey: ["setups", id, "events"],
    queryFn: () => api<SetupEvent[]>(`/api/setups/${id}/events`),
  });
  const ohlcv = useQuery({
    queryKey: ["setups", id, "ohlcv"],
    queryFn: async (): Promise<Candle[]> => {
      const rows = await api<
        { timestamp: string; open: number; high: number; low: number; close: number }[]
      >(`/api/setups/${id}/ohlcv`);
      return rows.map((r) => ({
        time: Math.floor(new Date(r.timestamp).getTime() / 1000) as Candle["time"],
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
      }));
    },
    staleTime: 60_000,
    retry: false,
  });

  if (setup.isLoading) return <div>Chargement…</div>;
  if (setup.error || !setup.data) return <div>Erreur</div>;

  const s = setup.data;
  const live = ACTIVE.has(s.status);
  const meta = outcomeMeta(s.outcome);
  const headerBadgeClass = meta?.badge ?? (live ? liveBadgeClass() : "");
  const headerBadgeLabel = meta?.label ?? (live ? "Live" : s.status);

  const confirmedEvent = events.data?.find((e) => e.type === "Confirmed");
  const cp = confirmedEvent?.payload?.data as
    | { entry?: number; stopLoss?: number; takeProfit?: number[] }
    | undefined;

  const levels: Level[] = [
    cp?.entry ? { price: cp.entry, label: "Entry", color: "#60a5fa" } : null,
    cp?.stopLoss ? { price: cp.stopLoss, label: "SL", color: "#f87171" } : null,
    s.invalidationLevel
      ? { price: Number(s.invalidationLevel), label: "Invalidation", color: "#9ca3af" }
      : null,
    ...(cp?.takeProfit ?? []).map((p, i) => ({
      price: p,
      label: `TP${i + 1}`,
      color: "#34d399",
    })),
  ].filter((x): x is Level => x !== null);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <Link
          to={`/watches/${s.watchId}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← {s.watchId}
        </Link>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-bold font-mono">
            {s.asset} {s.timeframe}
          </h1>
          {s.direction && (
            <Badge variant={s.direction === "LONG" ? "default" : "destructive"}>
              {s.direction}
            </Badge>
          )}
          {s.patternHint && <span className="text-sm text-muted-foreground">{s.patternHint}</span>}
          <Badge variant="outline" className={cn("text-xs uppercase", headerBadgeClass)}>
            {headerBadgeLabel}
          </Badge>
          {live && (
            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => forceTick.mutate(s.watchId)}
                disabled={forceTick.isPending}
                title="Re-scan immédiat de la watch parent"
              >
                <Zap className="size-3.5" />
                Force tick
              </Button>
              <ConfirmAction
                title={`Tuer le setup ${s.id.slice(0, 8)} ?`}
                description="Le workflow Setup est terminé. L'historique reste en DB."
                trigger={
                  <Button size="sm" variant="destructive">
                    Kill setup
                  </Button>
                }
                onConfirm={() => {
                  if (id) killSetup.mutate({ setupId: id });
                }}
                destructive
              />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground font-mono">
          <span>score actuel {Number(s.currentScore).toFixed(0)} / 100</span>
          <span>·</span>
          <span>
            durée {fmtDuration(s.createdAt, s.closedAt)}
            {s.closedAt && " (fermé)"}
          </span>
          <span>·</span>
          <span>{events.data?.length ?? 0} events</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6">
        {/* Left: chart + key levels */}
        <div className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Chart</h3>
          {ohlcv.data ? (
            <TVChart candles={ohlcv.data} levels={levels} />
          ) : (
            <div className="h-[360px] bg-card border border-border rounded-md grid place-items-center text-muted-foreground text-sm">
              {ohlcv.isLoading ? "Chargement OHLCV…" : "Pas de données OHLCV pour ce setup"}
            </div>
          )}
          <KeyLevels
            entry={cp?.entry}
            sl={cp?.stopLoss}
            tp={cp?.takeProfit}
            invalidation={s.invalidationLevel ? Number(s.invalidationLevel) : null}
          />
        </div>

        {/* Right: narrative timeline */}
        <div>
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-3">Histoire</h3>
          {events.data && events.data.length > 0 ? (
            <NarrativeTimeline events={events.data} />
          ) : (
            <div className="text-xs text-muted-foreground">Pas encore d'événements.</div>
          )}
        </div>
      </div>

      <SetupLessonsSpotlight setupId={s.id} />
    </div>
  );
}
