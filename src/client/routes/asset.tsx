import { AssetChart, type AssetCandle } from "../components/asset/asset-chart";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useCandleAlignedRefetch } from "../hooks/useCandleAlignedRefetch";
import { api } from "../lib/api";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

type OhlcvResp = {
  source: "binance" | "yahoo";
  symbol: string;
  interval: Timeframe;
  candles: AssetCandle[];
};

export function Component() {
  const { source: sourceParam, symbol: symbolParam } = useParams<{
    source: string;
    symbol: string;
  }>();
  const source = (sourceParam === "binance" || sourceParam === "yahoo")
    ? sourceParam
    : null;
  const symbol = symbolParam ? decodeURIComponent(symbolParam) : "";

  const [interval, setInterval] = useState<Timeframe>("1h");

  const ohlcv = useQuery({
    queryKey: ["asset-ohlcv", source, symbol, interval],
    queryFn: () =>
      api<OhlcvResp>(
        `/api/assets/${source}/${encodeURIComponent(symbol)}/ohlcv?interval=${interval}&limit=300`,
      ),
    enabled: !!source && !!symbol,
  });

  // Refresh aligned to candle close — when the chart shows 1h candles, we
  // refetch at :00 of every hour (with a 1s buffer).
  useCandleAlignedRefetch(interval, () => {
    ohlcv.refetch();
  });

  if (!source) {
    return <div className="text-destructive">Source invalide : {sourceParam}</div>;
  }

  const last = ohlcv.data?.candles.at(-1);
  const prev = ohlcv.data?.candles.at(-2);
  const change = last && prev ? ((last.close - prev.close) / prev.close) * 100 : null;

  // Pre-fill query string for the wizard
  const createWatchHref = (() => {
    const tfs = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"];
    const tfForWatch = tfs.includes(interval) ? interval : "1h";
    const slug = `${symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${tfForWatch}`.replace(
      /^-+|-+$/g,
      "",
    );
    return `/watches/new?source=${source}&symbol=${encodeURIComponent(symbol)}&timeframe=${tfForWatch}&id=${slug}`;
  })();

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-3 text-sm">
        <Link
          to="/search"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ArrowLeft className="size-4" />
          Retour à la recherche
        </Link>
      </div>

      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold font-mono">{symbol}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="secondary" className="text-xs">
              {source}
            </Badge>
            {last && (
              <>
                <span className="font-mono text-lg">
                  {last.close.toLocaleString(undefined, { maximumFractionDigits: 8 })}
                </span>
                {change !== null && (
                  <span
                    className={`font-mono text-sm ${
                      change >= 0 ? "text-emerald-500" : "text-red-500"
                    }`}
                  >
                    {change >= 0 ? "+" : ""}
                    {change.toFixed(2)}%
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        <Button asChild size="lg">
          <Link to={createWatchHref}>
            <Plus className="size-4" />
            Créer un watch sur cet actif
          </Link>
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            type="button"
            onClick={() => setInterval(tf)}
            className={`px-3 py-1.5 rounded-md text-xs font-mono border transition-colors ${
              interval === tf
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border hover:bg-card"
            }`}
          >
            {tf}
          </button>
        ))}
        <button
          type="button"
          onClick={() => ohlcv.refetch()}
          disabled={ohlcv.isFetching}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          title="Rafraîchir maintenant"
        >
          <RefreshCw className={`size-3 ${ohlcv.isFetching ? "animate-spin" : ""}`} />
          {ohlcv.dataUpdatedAt && (
            <span>
              maj{" "}
              {new Date(ohlcv.dataUpdatedAt).toLocaleTimeString("fr-FR", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          )}
        </button>
      </div>

      {ohlcv.isLoading ? (
        <div className="h-[480px] bg-card border rounded-md grid place-items-center text-sm text-muted-foreground">
          Chargement OHLCV…
        </div>
      ) : ohlcv.error ? (
        <div className="h-[480px] bg-card border rounded-md grid place-items-center text-sm text-destructive">
          Erreur : {(ohlcv.error as Error).message}
        </div>
      ) : (
        <AssetChart candles={ohlcv.data?.candles ?? []} />
      )}

      <div className="text-xs text-muted-foreground">
        Refresh automatique à la fermeture de chaque bougie ({interval}).
      </div>
    </div>
  );
}
