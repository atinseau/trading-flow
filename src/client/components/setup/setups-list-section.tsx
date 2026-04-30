import { SetupCard, type SetupListItem } from "./setup-card";
import { SetupsStatsBar, type SetupsStats } from "./setups-stats-bar";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

type Category = "all" | "live" | "wins" | "losses" | "other";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "live", label: "Live" },
  { id: "wins", label: "Wins" },
  { id: "losses", label: "Losses" },
  { id: "other", label: "Autre" },
];

/**
 * Reusable setups list with category filter pills + stats bar.
 * Used by /setups (no watchId — global) and /watches/:id (watchId scoped).
 */
export function SetupsListSection({ watchId }: { watchId?: string }) {
  const [category, setCategory] = useState<Category>("all");

  const baseQuery = watchId ? `watchId=${encodeURIComponent(watchId)}` : "";
  const categoryQuery = category === "all" ? "" : `category=${category}`;
  const setupsUrl = `/api/setups?${[baseQuery, categoryQuery, "limit=200"].filter(Boolean).join("&")}`;
  const statsUrl = `/api/setups/stats${watchId ? `?watchId=${encodeURIComponent(watchId)}` : ""}`;

  const setups = useQuery({
    queryKey: ["setups", { watchId: watchId ?? null, category }],
    queryFn: () => api<SetupListItem[]>(setupsUrl),
    staleTime: 5_000,
  });
  const stats = useQuery({
    queryKey: ["setups", "stats", { watchId: watchId ?? null }],
    queryFn: () => api<SetupsStats>(statsUrl),
    staleTime: 30_000,
  });

  return (
    <div className="space-y-4">
      <SetupsStatsBar stats={stats.data} loading={stats.isLoading} />

      <div className="flex items-center gap-2 flex-wrap">
        {CATEGORIES.map((c) => {
          const active = category === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              className={cn(
                "px-3 py-1 rounded-full text-xs border transition-colors",
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border hover:bg-card",
              )}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {setups.isLoading && <div className="text-sm text-muted-foreground">Chargement…</div>}
      {setups.error && (
        <div className="text-sm text-destructive">Erreur : {(setups.error as Error).message}</div>
      )}
      {setups.data && setups.data.length === 0 && !setups.isLoading && (
        <div className="border border-dashed rounded-lg p-12 text-center text-sm text-muted-foreground">
          Aucun setup pour ce filtre.
        </div>
      )}
      {setups.data && setups.data.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {setups.data.map((s) => (
            <SetupCard key={s.id} setup={s} />
          ))}
        </div>
      )}
    </div>
  );
}
