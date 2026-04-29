import { WatchForm } from "../components/watch-form";
import { api } from "../lib/api";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

const VALID_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"] as const;
const VALID_SOURCES = ["binance", "yahoo"] as const;

export function Component() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();

  // Optional pre-fill from /assets/:source/:symbol "Create watch" button.
  // Only applies known-valid values; unknown source/timeframe is ignored.
  const preset = (() => {
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
              ...(sourceOk ? { source } : {}),
            } as { symbol?: string; source?: string },
          }
        : {}),
      ...(tfOk ? { timeframes: { primary: timeframe } } : {}),
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

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">Nouvelle watch</h1>
      <WatchForm
        mode="create"
        preset={preset}
        onSubmit={(c) => create.mutate(c)}
      />
    </div>
  );
}
