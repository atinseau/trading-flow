import { useRouteError } from "react-router-dom";

export function ErrorPage() {
  const err = useRouteError() as { message?: string } | undefined;
  return (
    <div className="p-8">
      <h1 className="text-xl font-bold">Erreur</h1>
      <p className="text-muted-foreground mt-2">
        {err?.message ?? "Quelque chose s'est mal passé."}
      </p>
    </div>
  );
}
