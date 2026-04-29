import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { WatchCard } from "../components/watch-card";
import { useWatches } from "../hooks/useWatches";
import { api } from "../lib/api";
import { fmtCost } from "../lib/format";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, DollarSign, Eye, TrendingUp, Zap } from "lucide-react";
import { Link } from "react-router-dom";

type Setup = { id: string; status: string; watchId: string; currentScore: string; asset: string };
type EventRow = { id: string; type: string };
type CostAgg = { key: string; totalUsd: number; count: number };

const FEATURED_ASSETS: { source: "binance" | "yahoo"; symbol: string; name: string; type: string }[] = [
  { source: "binance", symbol: "BTCUSDT", name: "Bitcoin", type: "Crypto" },
  { source: "binance", symbol: "ETHUSDT", name: "Ethereum", type: "Crypto" },
  { source: "binance", symbol: "SOLUSDT", name: "Solana", type: "Crypto" },
  { source: "yahoo", symbol: "AAPL", name: "Apple", type: "Action" },
  { source: "yahoo", symbol: "TSLA", name: "Tesla", type: "Action" },
  { source: "yahoo", symbol: "^GSPC", name: "S&P 500", type: "Indice" },
  { source: "yahoo", symbol: "EURUSD=X", name: "EUR / USD", type: "Forex" },
  { source: "yahoo", symbol: "GC=F", name: "Or (Gold)", type: "Future" },
];

function StatCard(props: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">{props.label}</span>
          <span className="text-muted-foreground">{props.icon}</span>
        </div>
        {props.loading ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <div className="text-2xl font-bold font-mono tabular-nums">{props.value}</div>
        )}
        {props.hint && <div className="text-xs text-muted-foreground">{props.hint}</div>}
      </CardContent>
    </Card>
  );
}

export function Component() {
  const watches = useWatches();
  const setups = useQuery({
    queryKey: ["setups"],
    queryFn: () => api<Setup[]>("/api/setups?limit=200"),
    staleTime: 5_000,
  });
  const recentEvents = useQuery({
    queryKey: ["events"],
    queryFn: () => api<EventRow[]>("/api/events?limit=200"),
    staleTime: 10_000,
  });
  const costs = useQuery({
    queryKey: ["costs", { groupBy: "watch" }],
    queryFn: () => api<CostAgg[]>("/api/costs?groupBy=watch"),
    staleTime: 60_000,
  });

  const enabledWatches = watches.data?.filter((w) => w.enabled) ?? [];
  const aliveSetups =
    setups.data?.filter(
      (s) => !["EXPIRED", "REJECTED", "INVALIDATED", "TP_HIT", "SL_HIT", "KILLED"].includes(s.status),
    ) ?? [];
  const totalCost = costs.data?.reduce((sum, c) => sum + c.totalUsd, 0) ?? 0;
  const topScore = aliveSetups.reduce(
    (max, s) => Math.max(max, Number(s.currentScore)),
    0,
  );
  const topSetup = aliveSetups.find((s) => Number(s.currentScore) === topScore && topScore > 0);

  // Watches preview: 3 most recently active (proxied by updatedAt order from API)
  const watchesPreview = (watches.data ?? []).slice(0, 3);

  return (
    <div className="space-y-10">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Bienvenue 👋</h1>
        <p className="text-sm text-muted-foreground">
          État du système et raccourcis rapides. Le détail vit dans les onglets dédiés.
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<Eye className="size-4" />}
          label="Watches actives"
          value={enabledWatches.length}
          hint={
            watches.data && watches.data.length > enabledWatches.length
              ? `${watches.data.length - enabledWatches.length} en pause`
              : "toutes en route"
          }
          loading={watches.isLoading}
        />
        <StatCard
          icon={<Activity className="size-4" />}
          label="Setups vivants"
          value={aliveSetups.length}
          hint={topScore > 0 ? `top score ${topScore.toFixed(0)}` : undefined}
          loading={setups.isLoading}
        />
        <StatCard
          icon={<Zap className="size-4" />}
          label="Events (récents)"
          value={recentEvents.data?.length ?? 0}
          hint="200 derniers"
          loading={recentEvents.isLoading}
        />
        <StatCard
          icon={<DollarSign className="size-4" />}
          label="Coût LLM"
          value={fmtCost(totalCost)}
          hint="cumulé toutes watches"
          loading={costs.isLoading}
        />
      </div>

      {/* Top setup spotlight */}
      {topSetup && (
        <Card className="border-primary/40">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="size-10 rounded-lg bg-primary/10 grid place-items-center">
              <TrendingUp className="size-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold font-mono">{topSetup.asset}</span>
                <Badge variant="secondary">{topSetup.status}</Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Setup le plus avancé en ce moment — score{" "}
                <span className="font-mono">{Number(topSetup.currentScore).toFixed(0)}</span> / 100
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to={`/setups/${topSetup.id}`}>
                Détail <ArrowRight className="size-3" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Watches preview */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Mes watches
          </h2>
          <Button asChild variant="ghost" size="sm">
            <Link to="/watches">
              Voir toutes <ArrowRight className="size-3" />
            </Link>
          </Button>
        </div>
        {watches.isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
        ) : watchesPreview.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {watchesPreview.map((w) => (
              <WatchCard key={w.id} watch={w} />
            ))}
          </div>
        ) : (
          <Card className="border-dashed">
            <CardContent className="p-8 text-center space-y-3">
              <p className="text-sm text-muted-foreground">
                Aucune watch encore configurée. Démarre par chercher un actif qui t'intéresse.
              </p>
              <div className="flex gap-2 justify-center">
                <Button asChild variant="outline">
                  <Link to="/search">Rechercher un actif</Link>
                </Button>
                <Button asChild>
                  <Link to="/watches/new">Créer une watch</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      {/* Featured assets */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Actifs à explorer
          </h2>
          <Button asChild variant="ghost" size="sm">
            <Link to="/search">
              Recherche libre <ArrowRight className="size-3" />
            </Link>
          </Button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {FEATURED_ASSETS.map((a) => (
            <Link
              key={`${a.source}|${a.symbol}`}
              to={`/assets/${a.source}/${encodeURIComponent(a.symbol)}`}
              className="group rounded-lg border bg-card hover:bg-accent transition-colors p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono font-bold truncate">{a.symbol}</div>
                  <div className="text-xs text-muted-foreground truncate">{a.name}</div>
                </div>
                <Badge variant="outline" className="text-[10px]">
                  {a.type}
                </Badge>
              </div>
              <div className="mt-2 text-[10px] text-muted-foreground/70 group-hover:text-foreground/70 transition-colors">
                Voir le graphique →
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
