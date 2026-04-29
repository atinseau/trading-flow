import { Button } from "@client/components/ui/button";
import { WatchCard } from "@client/components/watch-card";
import { useWatches } from "@client/hooks/useWatches";
import { Link } from "react-router-dom";

export function Component() {
  const { data, isLoading, error } = useWatches();

  if (isLoading) return <div className="text-muted-foreground">Chargement…</div>;
  if (error) return <div className="text-destructive">Erreur : {(error as Error).message}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Watches</h1>
        <Button asChild>
          <Link to="/watches/new">+ Nouvelle watch</Link>
        </Button>
      </div>
      {data && data.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.map((w) => (
            <WatchCard key={w.id} watch={w} />
          ))}
        </div>
      ) : (
        <div className="border border-dashed border-border rounded-lg p-12 text-center">
          <p className="text-muted-foreground mb-4">Aucune watch configurée pour l'instant.</p>
          <Button asChild>
            <Link to="/watches/new">Créer la première watch</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
