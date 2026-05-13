/**
 * Pure functions deriving the replay chart's playhead — extracted from
 * `replay-session.tsx` so the logic can be unit-tested cheaply (the
 * component itself needs a React + Query + Router stack to render).
 *
 * The playhead is the "now" pointer on a replay session: candles at or
 * before it are revealed to the bot, candles after it are visible only
 * to the user. The frontend's job is to keep it in sync with what the
 * workflow has actually processed.
 */

/** Minimal shape we need from a `ReplayEventRow` — keeps the helper UI-free. */
export type PlayheadEvent = { occurredAt: string };

/**
 * Find the latest event timestamp that falls inside the session window.
 *
 * **Why clamp to the window.** Most event types use the candle's
 * `timestamp` as `occurredAt` (so the playhead lines up with the chart),
 * but `ReplayMeta` events for `paused` / `failed` use wall-clock time —
 * which can land outside `[windowStart, windowEnd]`. Without clamping,
 * pausing a session in 2026-05 would jump the playhead off a 2026-04
 * window. Returns `null` if no event falls inside the window.
 */
export function findLastEventAtInWindow(
  events: readonly PlayheadEvent[],
  windowStartAt: Date,
  windowEndAt: Date,
): Date | null {
  const lo = windowStartAt.getTime();
  const hi = windowEndAt.getTime();
  let maxMs = -1;
  for (const e of events) {
    const t = new Date(e.occurredAt).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < lo || t > hi) continue;
    if (t > maxMs) maxMs = t;
  }
  return maxMs >= 0 ? new Date(maxMs) : null;
}

/**
 * Derive the playhead the chart should render. Priority :
 *
 *  1. **User scrub** — if the user is dragging the slider, honor their
 *     position absolutely. They want to inspect a past moment, not be
 *     yanked forward by a freshly-arrived event.
 *  2. **Latest persisted event in the window** — the workflow's actual
 *     progress, surviving reloads.
 *  3. **`windowStartAt`** — the session is fresh; nothing processed yet.
 *     The first Step then advances from here by one timeframe.
 *
 * **Anti-regression.** Returning `windowEndAt` here was the original bug
 * that made every "Step" send `tickAt = windowEndAt` (the workflow
 * completes the session in one click) and collapsed the chart's
 * past/future split (everything is "past"). Don't reintroduce.
 */
export function derivePlayheadAt(args: {
  windowStartAt: Date;
  windowEndAt: Date;
  events: readonly PlayheadEvent[];
  scrubMs: number | null;
}): Date {
  if (args.scrubMs !== null) return new Date(args.scrubMs);
  const lastEventAt = findLastEventAtInWindow(args.events, args.windowStartAt, args.windowEndAt);
  return lastEventAt ?? args.windowStartAt;
}
