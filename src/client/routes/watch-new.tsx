import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { WatchForm, type WatchFormPreset } from "../components/watch-form";
import { api } from "../lib/api";
import type { YahooMetadata } from "../lib/yahooMetadata";

const VALID_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"] as const;
const VALID_SOURCES = ["binance", "yahoo"] as const;

export function Component() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();

  // Optional pre-fill from /assets/:source/:symbol "Create watch" button.
  // Only applies known-valid values; unknown source/timeframe is ignored.
  const preset: WatchFormPreset | undefined = (() => {
    const source = searchParams.get("source");
    const symbol = searchParams.get("symbol");
    const timeframe = searchParams.get("timeframe");
    const id = searchParams.get("id");
    const sourceOk = source && VALID_SOURCES.includes(source as never);
    const tfOk = timeframe && VALID_TIMEFRAMES.includes(timeframe as never);
    if (!sourceOk && !symbol && !tfOk && !id) return undefined;
    return {
      ...(id ? { id } : {}),
      ...(symbol || sourceOk
        ? {
            asset: {
              ...(symbol ? { symbol } : {}),
              ...(sourceOk && source ? { source } : {}),
            },
          }
        : {}),
      ...(tfOk && timeframe ? { timeframes: { primary: timeframe } } : {}),
    };
  })();

  // Yahoo source requires quoteType (and sometimes exchange) — symmetric to
  // the server-side enrichment in api/watches.ts. We resolve it client-side
  // so the form's schema validation can pass on first submit attempt.
  const needsYahooLookup = preset?.asset?.source === "yahoo" && !!preset.asset.symbol;
  const yahooMeta = useQuery({
    queryKey: ["yahoo-lookup", preset?.asset?.symbol],
    queryFn: () =>
      api<YahooMetadata>(`/api/yahoo/lookup?symbol=${encodeURIComponent(preset!.asset!.symbol!)}`),
    enabled: needsYahooLookup,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const enrichedPreset: WatchFormPreset | undefined = (() => {
    if (!preset) return undefined;
    if (!needsYahooLookup || !yahooMeta.data) return preset;
    return {
      ...preset,
      asset: {
        ...preset.asset,
        quoteType: yahooMeta.data.quoteType,
        ...(yahooMeta.data.exchange ? { exchange: yahooMeta.data.exchange } : {}),
      },
    };
  })();

  const create = useMutation({
    mutationFn: (config: WatchConfig) =>
      api("/api/watches", { method: "POST", body: JSON.stringify(config) }),
    onSuccess: (_d, config) => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      toast.success("Watch créée");
      nav(`/watches/${config.id}`);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (needsYahooLookup && yahooMeta.isLoading) {
    return (
      <div>
        <h1 className="text-xl font-bold mb-6">Nouvelle watch</h1>
        <div className="text-sm text-muted-foreground">
          Recherche du symbole {preset?.asset?.symbol} sur Yahoo…
        </div>
      </div>
    );
  }
  if (needsYahooLookup && yahooMeta.isError) {
    return (
      <div>
        <h1 className="text-xl font-bold mb-6">Nouvelle watch</h1>
        <div className="text-sm text-destructive">
          Symbole {preset?.asset?.symbol} introuvable sur Yahoo. Vérifie le ticker ou choisis une
          autre source.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">Nouvelle watch</h1>
      <WatchForm mode="create" preset={enrichedPreset} onSubmit={(c) => create.mutate(c)} />
    </div>
  );
}
