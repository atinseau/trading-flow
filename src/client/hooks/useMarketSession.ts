import {
  getSession,
  getSessionState,
  type Session,
  type SessionState,
  type WatchAssetInput,
} from "@domain/services/marketSession";
import { useEffect, useMemo, useState } from "react";

/**
 * Reactive hook returning the current market session + state for a watch-like
 * input. Recomputes every minute so the badge label ("ouvre dans 8h12") stays
 * fresh. Returns null fields if the watch has invalid asset metadata (unknown
 * exchange, missing quoteType, etc.) — caller should hide the badge in that case.
 */
export function useMarketSession(watch: WatchAssetInput): {
  session: Session | null;
  state: SessionState | null;
} {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const session = useMemo<Session | null>(() => {
    try {
      return getSession(watch);
    } catch {
      return null;
    }
  }, [watch]);

  const state = useMemo<SessionState | null>(
    () => (session ? getSessionState(session, now) : null),
    [session, now],
  );

  return { session, state };
}
