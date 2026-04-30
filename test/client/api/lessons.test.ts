import { describe, expect, test } from "bun:test";
import { compareLessonsForDisplay } from "@client/api/lessons";

const make = (overrides: {
  pinned?: boolean;
  timesReinforced?: number;
  createdAt?: string;
  id?: string;
}) => ({
  id: overrides.id ?? "x",
  pinned: overrides.pinned ?? false,
  timesReinforced: overrides.timesReinforced ?? 0,
  createdAt: new Date(overrides.createdAt ?? "2026-01-01T00:00:00Z"),
});

describe("compareLessonsForDisplay", () => {
  test("pinned comes before unpinned regardless of other fields", () => {
    const pinnedOld = make({ id: "p", pinned: true, timesReinforced: 0, createdAt: "2026-01-01" });
    const unpinnedRecentReinforced = make({
      id: "u",
      pinned: false,
      timesReinforced: 99,
      createdAt: "2026-04-01",
    });
    const sorted = [unpinnedRecentReinforced, pinnedOld].sort(compareLessonsForDisplay);
    expect(sorted.map((x) => x.id)).toEqual(["p", "u"]);
  });

  test("among same pinned-state, more reinforced wins", () => {
    const less = make({ id: "less", timesReinforced: 1, createdAt: "2026-04-01" });
    const more = make({ id: "more", timesReinforced: 5, createdAt: "2026-01-01" });
    const sorted = [less, more].sort(compareLessonsForDisplay);
    expect(sorted.map((x) => x.id)).toEqual(["more", "less"]);
  });

  test("ties on pinned + reinforced break by createdAt desc", () => {
    const old = make({ id: "old", timesReinforced: 3, createdAt: "2026-01-01" });
    const recent = make({ id: "recent", timesReinforced: 3, createdAt: "2026-04-01" });
    const sorted = [old, recent].sort(compareLessonsForDisplay);
    expect(sorted.map((x) => x.id)).toEqual(["recent", "old"]);
  });

  test("realistic mixed list", () => {
    const list = [
      make({ id: "a", pinned: false, timesReinforced: 2, createdAt: "2026-03-01" }),
      make({ id: "b", pinned: true, timesReinforced: 0, createdAt: "2026-02-01" }),
      make({ id: "c", pinned: true, timesReinforced: 5, createdAt: "2026-01-01" }),
      make({ id: "d", pinned: false, timesReinforced: 10, createdAt: "2026-01-15" }),
      make({ id: "e", pinned: false, timesReinforced: 2, createdAt: "2026-04-01" }),
    ];
    const sorted = list.sort(compareLessonsForDisplay);
    // pinned first (c then b — c more reinforced), then unpinned by reinforced desc, ties by date desc
    expect(sorted.map((x) => x.id)).toEqual(["c", "b", "d", "e", "a"]);
  });
});
