import type {
  CostBreakdownResponse,
  OhlcvResponse,
  ReplayEventRow,
  ReplaySessionRow,
  SetupProjectionRow,
} from "@client/components/replay/replay-types";
import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";

/**
 * React Query bindings for one replay session. Jalon 1: read-only —
 * step/pause/resume mutations are stubbed and disabled. Jalon 2 wires
 * the mutations to the corresponding endpoints.
 */
export function useReplaySteps(sessionId: string) {
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

  return {
    session,
    events,
    setups,
    ohlcv,
    cost,
    // Mutations placeholders — enabled in Jalon 2.
    step: {
      mutate: () => undefined as void,
      isPending: false,
      isDisabled: true,
    },
    pause: {
      mutate: () => undefined as void,
      isPending: false,
      isDisabled: true,
    },
    resume: {
      mutate: () => undefined as void,
      isPending: false,
      isDisabled: true,
    },
  };
}
