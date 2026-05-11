import { describe, expect, test } from "bun:test";
import { filterLessonsForReplay, type LessonLike } from "@domain/replay/lessonsLookup";

const D = (iso: string) => new Date(iso);

const lessons: LessonLike[] = [
  // L0 : created and activated before the window, still active
  {
    id: "L0",
    watchId: "btc-1h",
    status: "ACTIVE",
    activatedAt: D("2026-03-01T00:00:00.000Z"),
    deprecatedAt: null,
  },
  // L1 : activated after the window start (anachronistic)
  {
    id: "L1",
    watchId: "btc-1h",
    status: "ACTIVE",
    activatedAt: D("2026-04-15T00:00:00.000Z"),
    deprecatedAt: null,
  },
  // L2 : activated before the window, deprecated after — should be alive at windowStart
  {
    id: "L2",
    watchId: "btc-1h",
    status: "ACTIVE",
    activatedAt: D("2026-03-15T00:00:00.000Z"),
    deprecatedAt: D("2026-04-20T00:00:00.000Z"),
  },
  // L3 : activated before the window, deprecated before the window — dead at windowStart
  {
    id: "L3",
    watchId: "btc-1h",
    status: "ACTIVE", // status loose ; we filter on activation/deprecation dates for historical
    activatedAt: D("2026-02-01T00:00:00.000Z"),
    deprecatedAt: D("2026-04-10T00:00:00.000Z"),
  },
  // L4 : pending / never activated
  {
    id: "L4",
    watchId: "btc-1h",
    status: "PENDING",
    activatedAt: null,
    deprecatedAt: null,
  },
];

const windowStart = D("2026-04-12T14:00:00.000Z");

describe("filterLessonsForReplay", () => {
  test("disabled → always empty", () => {
    expect(filterLessonsForReplay(lessons, "disabled", windowStart)).toEqual([]);
    expect(filterLessonsForReplay([], "disabled", windowStart)).toEqual([]);
  });

  test("current → ACTIVE and not deprecated, regardless of date", () => {
    const out = filterLessonsForReplay(lessons, "current", windowStart);
    const ids = out.map((l) => l.id).sort();
    // L0, L1 active+not-deprecated. L2 active but deprecated (deprecatedAt non-null) → excluded.
    expect(ids).toEqual(["L0", "L1"]);
  });

  test("historical → activated before windowStart AND not yet deprecated at windowStart", () => {
    const out = filterLessonsForReplay(lessons, "historical", windowStart);
    const ids = out.map((l) => l.id).sort();
    // L0 : activated 2026-03-01, not deprecated → IN
    // L1 : activated 2026-04-15 (after windowStart) → OUT
    // L2 : activated 2026-03-15, deprecated 2026-04-20 (after windowStart) → IN
    // L3 : activated 2026-02-01, deprecated 2026-04-10 (before windowStart) → OUT
    // L4 : never activated → OUT
    expect(ids).toEqual(["L0", "L2"]);
  });

  test("historical → boundary: lesson deprecated exactly at windowStart is excluded", () => {
    const l: LessonLike = {
      id: "X",
      watchId: "btc-1h",
      status: "ACTIVE",
      activatedAt: D("2026-04-01T00:00:00.000Z"),
      deprecatedAt: windowStart,
    };
    expect(filterLessonsForReplay([l], "historical", windowStart)).toEqual([]);
  });

  test("historical → boundary: lesson activated exactly at windowStart is included", () => {
    const l: LessonLike = {
      id: "Y",
      watchId: "btc-1h",
      status: "ACTIVE",
      activatedAt: windowStart,
      deprecatedAt: null,
    };
    expect(filterLessonsForReplay([l], "historical", windowStart)).toEqual([l]);
  });

  test("empty input → empty output for all modes", () => {
    expect(filterLessonsForReplay([], "current", windowStart)).toEqual([]);
    expect(filterLessonsForReplay([], "historical", windowStart)).toEqual([]);
    expect(filterLessonsForReplay([], "disabled", windowStart)).toEqual([]);
  });
});
