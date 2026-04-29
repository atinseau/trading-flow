import { EventsTimeline, type SetupEvent } from "@client/components/setup/events-timeline";
import { KeyLevels } from "@client/components/setup/key-levels";
import { ScoreChart } from "@client/components/setup/score-chart";
import { type Candle, type Level, TVChart } from "@client/components/setup/tv-chart";
import { ConfirmAction } from "@client/components/shared/confirm-action";
import { Badge } from "@client/components/ui/badge";
import { Button } from "@client/components/ui/button";
import { useAdminAction } from "@client/hooks/useAdminAction";
import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

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
};

export function Component() {
  const { id } = useParams<{ id: string }>();
  const { killSetup } = useAdminAction();

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
    queryFn: () => api<Candle[]>(`/api/setups/${id}/ohlcv`),
    staleTime: 60_000,
  });

  if (setup.isLoading) return <div>Chargement…</div>;
  if (setup.error || !setup.data) return <div>Erreur</div>;

  const confirmedPayload = events.data
    ? events.data.findLast?.((e) => e.type === "Confirmed")?.payload?.data
    : undefined;
  const cp = confirmedPayload as
    | { entry?: number; stopLoss?: number; takeProfit?: number[] }
    | undefined;

  const levels: Level[] = [
    cp?.entry ? { price: cp.entry, label: "Entry", color: "#60a5fa" } : null,
    cp?.stopLoss ? { price: cp.stopLoss, label: "SL", color: "#f87171" } : null,
    setup.data.invalidationLevel
      ? { price: Number(setup.data.invalidationLevel), label: "Invalidation", color: "#9ca3af" }
      : null,
    ...(cp?.takeProfit ?? []).map((p, i) => ({
      price: p,
      label: `TP${i + 1}`,
      color: "#34d399",
    })),
  ].filter((x): x is Level => x !== null);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-3">
        <Link to={`/watches/${setup.data.watchId}`} className="text-sm text-muted-foreground">
          ← {setup.data.watchId}
        </Link>
        <h1 className="text-xl font-bold font-mono">
          {setup.data.asset} {setup.data.timeframe}
        </h1>
        {setup.data.patternHint && (
          <span className="text-muted-foreground">{setup.data.patternHint}</span>
        )}
        {setup.data.direction && (
          <Badge variant={setup.data.direction === "LONG" ? "default" : "destructive"}>
            {setup.data.direction}
          </Badge>
        )}
        <Badge variant="secondary">{setup.data.status}</Badge>
        <ConfirmAction
          title={`Tuer le setup ${setup.data.id.slice(0, 8)} ?`}
          description="Le workflow Setup est terminé. L'historique reste en DB."
          trigger={
            <Button size="sm" variant="destructive" className="ml-auto">
              Kill setup
            </Button>
          }
          onConfirm={() => killSetup.mutate({ setupId: id! })}
          destructive
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6">
        <div className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Chart</h3>
          {ohlcv.data ? (
            <TVChart candles={ohlcv.data} levels={levels} />
          ) : (
            <div className="h-[360px] bg-card border border-border rounded-md grid place-items-center text-muted-foreground">
              {ohlcv.isLoading ? "Chargement OHLCV…" : "Pas de données OHLCV"}
            </div>
          )}
          <KeyLevels
            entry={cp?.entry}
            sl={cp?.stopLoss}
            tp={cp?.takeProfit}
            invalidation={
              setup.data.invalidationLevel ? Number(setup.data.invalidationLevel) : null
            }
          />
        </div>

        <div className="space-y-4">
          <div>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
              Évolution du score
            </h3>
            {events.data && events.data.length > 0 ? (
              <ScoreChart
                points={events.data.map((e) => ({
                  occurredAt: e.occurredAt,
                  scoreAfter: Number(e.scoreAfter),
                }))}
              />
            ) : (
              <div className="text-xs text-muted-foreground">Pas encore d'événements.</div>
            )}
          </div>
          <div>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
              Événements ({events.data?.length ?? 0})
            </h3>
            <EventsTimeline events={events.data ?? []} />
          </div>
        </div>
      </div>
    </div>
  );
}
