import { useEffect, useRef } from "react";

/**
 * Trigger a single `onTransition()` call ~`delayMs` after the workflow's
 * `tickInProgress` flips from `true` to `false`.
 *
 * Why this exists. `useReplaySteps` configures the workflow-state query
 * with `refetchInterval = busy ? 800 : 8000`. When a tick completes
 * *between* two 800ms polls, the next query observes `tickInProgress=false`
 * and immediately downshifts to the 8s cadence. Up to 7s of UI lag before
 * any other query (events, setups, cost) catches up. The fix : on the
 * busy→idle transition, dispatch one extra `invalidateAll()` after a
 * short delay so the freshly-persisted tick lands on the UI without
 * waiting for the slow heartbeat.
 *
 * The hook is intentionally side-effect-only — it does not own the
 * invalidation logic, just the transition detection. Tests mock
 * `onTransition` and assert it fires on the right edges.
 */
export function usePostBusyInvalidation(
  tickInProgress: boolean | undefined,
  onTransition: () => void,
  delayMs = 1000,
): void {
  const prevRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = tickInProgress;
    // Edge of interest : was-busy (true) → became-idle (false). Both ends
    // must be defined to count as a real transition (avoid spurious hits
    // on initial undefined → false render).
    if (prev !== true || tickInProgress !== false) return;
    const handle = setTimeout(onTransition, delayMs);
    return () => clearTimeout(handle);
  }, [tickInProgress, onTransition, delayMs]);
}
