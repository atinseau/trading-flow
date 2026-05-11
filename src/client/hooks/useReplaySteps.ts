import type {
  CostBreakdownResponse,
  OhlcvResponse,
  ReplayEventRow,
  ReplaySessionRow,
  SetupProjectionRow,
} from "@client/components/replay/replay-types";
import { api } from "@client/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * React Query bindings for one replay session.
 *
 * Reads (always live):
 *  - session metadata, events, setups projection, OHLCV, cost breakdown.
 *
 * Writes (Jalon 2):
 *  - `step({ tickAt })` advances the playhead by one candle. Posts to
 *    /api/replay/sessions/:id/step with the supplied tickAt. On success,
 *    invalidates events / setups / cost / session queries so the UI
 *    refreshes immediately.
 *  - `pause()` / `resume()` post to the corresponding signal endpoint.
 *    Invalidate the session query so the status badge updates.
 */
export function useReplaySteps(sessionId: string) {
  const queryClient = useQueryClient();

  const session = useQuery({
    queryKey: ["replay", sessionId, "session"],
    queryFn: () => api<ReplaySessionRow>(`/api/replay/sessions/${sessionId}`),
    staleTime: 5_000,
  });
  const events = useQuery({
    queryKey: ["replay", sessionId, "events"],
    queryFn: () => api<ReplayEventRow[]>(`/api/replay/sessions/${sessionId}/events`),
    staleTime: 5_000,
  });
  const setups = useQuery({
    queryKey: ["replay", sessionId, "setups"],
    queryFn: () => api<SetupProjectionRow[]>(`/api/replay/sessions/${sessionId}/setups`),
    staleTime: 5_000,
  });
  const ohlcv = useQuery({
    queryKey: ["replay", sessionId, "ohlcv"],
    queryFn: () => api<OhlcvResponse>(`/api/replay/sessions/${sessionId}/ohlcv`),
    staleTime: 60_000,
    retry: false,
  });
  const cost = useQuery({
    queryKey: ["replay", sessionId, "cost"],
    queryFn: () => api<CostBreakdownResponse>(`/api/replay/sessions/${sessionId}/cost-breakdown`),
    staleTime: 10_000,
  });

  function invalidateAll(): Promise<unknown> {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ["replay", sessionId, "session"] }),
      queryClient.invalidateQueries({ queryKey: ["replay", sessionId, "events"] }),
      queryClient.invalidateQueries({ queryKey: ["replay", sessionId, "setups"] }),
      queryClient.invalidateQueries({ queryKey: ["replay", sessionId, "cost"] }),
    ]);
  }

  const stepMut = useMutation({
    mutationFn: (args: { tickAt: string }) =>
      api(`/api/replay/sessions/${sessionId}/step`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
    // Step triggers a workflow tick that persists new events + cost in
    // the background. We poll for new events for a few seconds after the
    // signal to catch the workflow's output without forcing a websocket
    // dependency.
    onSuccess: async () => {
      await invalidateAll();
      // Soft refetch after a short delay — gives the workflow a moment
      // to land its events before the UI snapshots them.
      setTimeout(() => {
        void invalidateAll();
      }, 1500);
      setTimeout(() => {
        void invalidateAll();
      }, 4000);
    },
  });

  const pauseMut = useMutation({
    mutationFn: () => api(`/api/replay/sessions/${sessionId}/pause`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["replay", sessionId, "session"] });
    },
  });

  const resumeMut = useMutation({
    mutationFn: () => api(`/api/replay/sessions/${sessionId}/resume`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["replay", sessionId, "session"] });
    },
  });

  return {
    session,
    events,
    setups,
    ohlcv,
    cost,
    step: stepMut,
    pause: pauseMut,
    resume: resumeMut,
  };
}
