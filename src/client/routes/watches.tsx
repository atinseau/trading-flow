import { Button } from "../components/ui/button";
import { WatchCard } from "../components/watch-card";
import { useWatches } from "../hooks/useWatches";
import { Link } from "react-router-dom";

/**
 * /watches — list of all configured watches with admin actions.
 * Was the homepage; demoted to its own route so / can show a richer home.
 */
export function Component() {
  const { data, isLoading, error } = useWatches();

  if (isLoading) return <div className="text-muted-foreground">Chargement…</div>;
  if (error) return <div className="text-destructive">Erreur : {(error as Error).message}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Mes watches</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configuration, état et actions sur chaque watch.
          </p>
        </div>
        <Button asChild>
          <Link to="/watches/new">+ Nouvelle watch</Link>
        </Button>
      </div>
      {data && data.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.map((w) => <WatchCard key={w.id} watch={w} />)}
        </div>
      ) : (
        <div className="border border-dashed border-border rounded-lg p-12 text-center">
          <p className="text-muted-foreground mb-4">Aucune watch configurée pour l'instant.</p>
          <div className="flex gap-2 justify-center">
            <Button asChild variant="outline">
              <Link to="/search">Découvrir des actifs</Link>
            </Button>
            <Button asChild>
              <Link to="/watches/new">Créer une watch</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
