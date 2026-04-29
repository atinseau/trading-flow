import { api } from "@client/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export function useAdminAction() {
  const qc = useQueryClient();

  const forceTick = useMutation({
    mutationFn: (watchId: string) => api(`/api/watches/${watchId}/force-tick`, { method: "POST" }),
    onSuccess: (_d, watchId) => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      toast.success(`Tick forcé pour ${watchId}`);
    },
    onError: (err) => toast.error(`Échec : ${(err as Error).message}`),
  });

  const pause = useMutation({
    mutationFn: (watchId: string) => api(`/api/watches/${watchId}/pause`, { method: "POST" }),
    onSuccess: (_d, watchId) => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      toast.success(`${watchId} mis en pause`);
    },
    onError: (err) => toast.error(`Échec : ${(err as Error).message}`),
  });

  const resume = useMutation({
    mutationFn: (watchId: string) => api(`/api/watches/${watchId}/resume`, { method: "POST" }),
    onSuccess: (_d, watchId) => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      toast.success(`${watchId} relancée`);
    },
    onError: (err) => toast.error(`Échec : ${(err as Error).message}`),
  });

  const killSetup = useMutation({
    mutationFn: ({ setupId, reason }: { setupId: string; reason?: string }) =>
      api(`/api/setups/${setupId}/kill`, {
        method: "POST",
        body: JSON.stringify({ reason: reason ?? "manual_close" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["setups"] });
      toast.success("Setup tué");
    },
    onError: (err) => toast.error(`Échec : ${(err as Error).message}`),
  });

  return { forceTick, pause, resume, killSetup };
}
