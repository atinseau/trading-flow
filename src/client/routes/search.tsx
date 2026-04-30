import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";

type SearchResult = {
  symbol: string;
  name: string;
  source: "binance" | "yahoo";
  type: "crypto" | "stock" | "index" | "etf" | "currency" | "future" | "other";
  exchange?: string;
  score: number;
};

const TYPE_LABEL: Record<SearchResult["type"], string> = {
  crypto: "Crypto",
  stock: "Action",
  index: "Indice",
  etf: "ETF",
  currency: "Forex",
  future: "Future",
  other: "Autre",
};

const TYPE_FILTERS: SearchResult["type"][] = [
  "crypto",
  "stock",
  "index",
  "etf",
  "currency",
  "future",
];

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function Component() {
  const [q, setQ] = useState("");
  const [activeTypes, setActiveTypes] = useState<Set<SearchResult["type"]>>(new Set());
  const debouncedQ = useDebounced(q, 300);

  const typesParam = activeTypes.size > 0 ? [...activeTypes].join(",") : "";
  const { data, isLoading, error } = useQuery({
    queryKey: ["search", debouncedQ, typesParam],
    queryFn: () =>
      api<SearchResult[]>(
        `/api/search?q=${encodeURIComponent(debouncedQ)}${typesParam ? `&types=${typesParam}` : ""}`,
      ),
    enabled: debouncedQ.length > 0,
    staleTime: 5 * 60_000,
  });

  const toggleType = (t: SearchResult["type"]): void => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-bold">Rechercher un actif</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Crypto, actions, indices, forex, ETFs, futures. Source : Binance + Yahoo Finance.
        </p>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="ex: AAPL, BTC, S&P 500, EURUSD…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9 h-11 text-base"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {TYPE_FILTERS.map((t) => {
            const active = activeTypes.has(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleType(t)}
                className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:bg-card"
                }`}
              >
                {TYPE_LABEL[t]}
              </button>
            );
          })}
          {activeTypes.size > 0 && (
            <button
              type="button"
              onClick={() => setActiveTypes(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground px-2"
            >
              Réinitialiser
            </button>
          )}
        </div>
      </div>

      {q.length === 0 && (
        <div className="border border-dashed rounded-lg p-12 text-center text-sm text-muted-foreground">
          Tape au moins un caractère pour démarrer la recherche.
        </div>
      )}

      {q.length > 0 && isLoading && (
        <div className="text-sm text-muted-foreground">Recherche en cours…</div>
      )}

      {error && <div className="text-sm text-destructive">Erreur : {(error as Error).message}</div>}

      {data && data.length === 0 && q.length > 0 && !isLoading && (
        <div className="text-sm text-muted-foreground">Aucun résultat pour "{q}".</div>
      )}

      {data && data.length > 0 && (
        <div className="space-y-1">
          {data.map((r) => (
            <Link
              key={`${r.source}|${r.symbol}`}
              to={`/assets/${r.source}/${encodeURIComponent(r.symbol)}`}
              className="flex items-center gap-3 px-3 py-3 rounded-md border bg-card hover:bg-accent transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold">{r.symbol}</span>
                  <Badge variant="secondary" className="text-[10px] uppercase">
                    {TYPE_LABEL[r.type]}
                  </Badge>
                </div>
                <div className="text-sm text-muted-foreground truncate">{r.name}</div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <div className="font-mono">{r.source}</div>
                {r.exchange && <div>{r.exchange}</div>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
