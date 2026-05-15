import type {
  CostBreakdownResponse,
  OhlcvResponse,
  ReplayEventRow,
  ReplaySessionRow,
  SetupProjectionRow,
  WorkflowStateResponse,
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

  // Live workflow state — used to gate Step / Auto and render the
  // "raisonnement en cours" indicator. Polls fast (800ms) when the
  // workflow is actively crunching a tick or has queued ticks ; quiets
  // down to a slow heartbeat (8s) otherwise so we don't hammer Temporal
  // for nothing. `null` from the API means "workflow not started yet or
  // terminated" — both render as idle.
  const workflowState = useQuery({
    queryKey: ["replay", sessionId, "workflow-state"],
    queryFn: () => api<WorkflowStateResponse>(`/api/replay/sessions/${sessionId}/workflow-state`),
    refetchInterval: (q) => {
      const live = q.state.data?.live;
      if (live && (live.tickInProgress || live.pendingTicks > 0)) return 800;
      return 8_000;
    },
    // Always trigger an immediate refetch on mount so a tab that returns
    // from background catches up without waiting for the next interval.
    refetchOnWindowFocus: true,
  });

  function invalidateAll(): Promise<unknown> {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ["replay", sessionId, "session"] }),
      queryClient.invalidateQueries({ queryKey: ["replay", sessionId, "events"] }),
      queryClient.invalidateQueries({ queryKey: ["replay", sessionId, "setups"] }),
      queryClient.invalidateQueries({ queryKey: ["replay", sessionId, "cost"] }),
      queryClient.invalidateQueries({ queryKey: ["replay", sessionId, "workflow-state"] }),
    ]);
  }

  const stepMut = useMutation({
    mutationFn: (args: { tickAt: string } | { tickAts: string[] }) =>
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
    workflowState,
    step: stepMut,
    pause: pauseMut,
    resume: resumeMut,
    // Exposed so route-level effects (e.g. post-busy refresh after a tick
    // completes between two slow polls) can re-fetch without duplicating
    // the queryKey list. Lives here because the keys are local to the hook.
    invalidateAll,
  };
}
