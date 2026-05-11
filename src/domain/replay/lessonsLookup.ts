import type { LessonsMode } from "./ReplaySession";

/**
 * Subset of a `lessons` row needed to decide whether the lesson is
 * eligible for a given `lessons_mode` + window start. Adapter layer
 * maps the full DB row to this shape.
 */
export type LessonLike = {
  id: string;
  watchId: string;
  status: string; // "PENDING" | "ACTIVE" | "REJECTED" | "ARCHIVED" — kept loose to avoid coupling
  activatedAt: Date | null;
  deprecatedAt: Date | null;
};

/**
 * Filters lessons according to the replay session's `lessons_mode`
 * (see spec §6 "Lookup des lessons selon `lessons_mode`").
 *
 * - `disabled` → always `[]`. The bot replays with no learned guidelines.
 * - `current` → behaves like prod live : returns lessons currently ACTIVE
 *   and not deprecated, regardless of when they were activated.
 * - `historical` → returns lessons that were already ACTIVE at
 *   `windowStartAt` AND not yet deprecated at that point. Reproduces the
 *   bot's behavior as it would have been on the window's start date.
 *
 * The caller (the activity in replay mode) is responsible for fetching
 * `allLessons` from the live `lessons` table — this function is pure
 * and does no I/O.
 */
export function filterLessonsForReplay(
  allLessons: ReadonlyArray<LessonLike>,
  mode: LessonsMode,
  windowStartAt: Date,
): ReadonlyArray<LessonLike> {
  if (mode === "disabled") return [];
  if (mode === "current") {
    return allLessons.filter((l) => l.status === "ACTIVE" && l.deprecatedAt === null);
  }
  // historical
  return allLessons.filter((l) => {
    if (l.activatedAt === null) return false;
    if (l.activatedAt > windowStartAt) return false;
    if (l.deprecatedAt !== null && l.deprecatedAt <= windowStartAt) return false;
    return true;
  });
}
