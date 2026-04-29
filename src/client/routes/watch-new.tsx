import { WatchForm } from "../components/watch-form";
import { api } from "../lib/api";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

export function Component() {
  const qc = useQueryClient();
  const nav = useNavigate();
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
      <WatchForm mode="create" onSubmit={(c) => create.mutate(c)} />
    </div>
  );
}
