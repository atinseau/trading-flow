import { ConfirmAction } from "@client/components/shared/confirm-action";
import { RelativeTime } from "@client/components/shared/relative-time";
import { Badge } from "@client/components/ui/badge";
import { Button } from "@client/components/ui/button";
import { Card, CardContent, CardHeader } from "@client/components/ui/card";
import { useAdminAction } from "@client/hooks/useAdminAction";
import type { WatchListItem } from "@client/hooks/useWatches";
import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

type WatchDetail = {
  state: {
    lastTickAt: string | null;
    totalCostUsdMtd: string;
    setupsCreatedMtd: number;
  } | null;
};

export function WatchCard({ watch }: { watch: WatchListItem }) {
  const { forceTick, pause, resume } = useAdminAction();

  const detail = useQuery({
    queryKey: ["watches", watch.id],
    queryFn: () => api<WatchDetail>(`/api/watches/${watch.id}`),
    staleTime: 30_000,
  });

  const aliveSetups = useQuery({
    queryKey: ["setups", { watchId: watch.id, status: "alive" }],
    queryFn: () => api<unknown[]>(`/api/setups?watchId=${watch.id}`),
    staleTime: 5_000,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div>
          <Link to={`/watches/${watch.id}`} className="font-bold font-mono">
            {watch.config.asset.symbol} · {watch.config.timeframes.primary}
          </Link>
          <div className="text-xs text-muted-foreground mt-1">{watch.id}</div>
        </div>
        <Badge variant={watch.enabled ? "default" : "secondary"}>
          {watch.enabled ? "Active" : "Pause"}
        </Badge>
      </CardHeader>
      <CardContent className="text-xs space-y-1">
        <div>
          Dernier tick : <RelativeTime date={detail.data?.state?.lastTickAt} />
        </div>
        <div>
          Setups vivants : <span className="font-mono">{aliveSetups.data?.length ?? "—"}</span>
        </div>
        <div>
          Coût mois :{" "}
          <span className="font-mono">
            ${Number(detail.data?.state?.totalCostUsdMtd ?? 0).toFixed(2)}
          </span>
        </div>
        <div className="flex gap-2 pt-2">
          {watch.enabled ? (
            <>
              <Button size="sm" variant="outline" onClick={() => forceTick.mutate(watch.id)}>
                Force tick
              </Button>
              <ConfirmAction
                title={`Mettre en pause ${watch.id} ?`}
                description="Les ticks programmés sont suspendus. Reprends quand tu veux."
                trigger={
                  <Button size="sm" variant="outline">
                    Pause
                  </Button>
                }
                onConfirm={() => pause.mutate(watch.id)}
              />
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => resume.mutate(watch.id)}>
              Reprendre
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
