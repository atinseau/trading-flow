import { describe, expect, test } from "bun:test";
import type { AutoRejectReason, LessonAction } from "@domain/feedback/lessonAction";
import { type PoolSnapshot, validateActions } from "@domain/feedback/validateActions";

const lessonId = "11111111-1111-1111-1111-111111111111";
const otherWatchLessonId = "22222222-2222-2222-2222-222222222222";

const baseLesson = {
  id: lessonId,
  watchId: "btc-1h",
  category: "reviewing" as const,
  status: "ACTIVE" as const,
  pinned: false,
};

const pool: PoolSnapshot = {
  watchId: "btc-1h",
  watchSymbols: ["BTC", "BTCUSDT"],
  watchTimeframeStrings: ["1h", "4h"],
  capPerCategory: 30,
  activeByCategory: { detecting: [], reviewing: [baseLesson], finalizing: [] },
  pinnedById: new Map([[lessonId, false]]),
};

describe("validateActions", () => {
  test("CREATE within cap is applied", () => {
    const actions: LessonAction[] = [
      {
        type: "CREATE",
        category: "reviewing",
        title: "Trend exhaustion via low-vol consolidation",
        body: "z".repeat(60),
        rationale: "y".repeat(30),
      },
    ];
    const r = validateActions(actions, pool);
    expect(r.applied).toHaveLength(1);
    expect(r.rejected).toHaveLength(0);
  });

  test("CREATE that exceeds cap is rejected", () => {
    const actives = Array.from({ length: 30 }, (_, i) => ({
      ...baseLesson,
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    }));
    const fullPool: PoolSnapshot = {
      ...pool,
      activeByCategory: { detecting: [], reviewing: actives, finalizing: [] },
    };
    const actions: LessonAction[] = [
      {
        type: "CREATE",
        category: "reviewing",
        title: "Cap-overflow lesson title valid",
        body: "z".repeat(60),
        rationale: "y".repeat(30),
      },
    ];
    const r = validateActions(actions, fullPool);
    expect(r.applied).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toBe("cap_exceeded");
  });

  test("REINFORCE on existing ACTIVE lesson is applied", () => {
    const r = validateActions([{ type: "REINFORCE", lessonId, reason: "z".repeat(20) }], pool);
    expect(r.applied).toHaveLength(1);
  });

  test("REINFORCE with unknown lessonId is rejected", () => {
    const r = validateActions(
      [{ type: "REINFORCE", lessonId: otherWatchLessonId, reason: "z".repeat(20) }],
      pool,
    );
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toBe("lesson_not_found");
  });

  test("REFINE on pinned lesson is rejected", () => {
    const pinnedPool: PoolSnapshot = {
      ...pool,
      pinnedById: new Map([[lessonId, true]]),
    };
    const r = validateActions(
      [
        {
          type: "REFINE",
          lessonId,
          newTitle: "x".repeat(20),
          newBody: "y".repeat(60),
          rationale: "z".repeat(30),
        },
      ],
      pinnedPool,
    );
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toBe("pinned_lesson");
  });

  test("DEPRECATE on pinned lesson is rejected", () => {
    const pinnedPool: PoolSnapshot = {
      ...pool,
      pinnedById: new Map([[lessonId, true]]),
    };
    const r = validateActions(
      [{ type: "DEPRECATE", lessonId, reason: "z".repeat(20) }],
      pinnedPool,
    );
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toBe("pinned_lesson");
  });

  test("CREATE that mentions watch symbol is rejected", () => {
    const r = validateActions(
      [
        {
          type: "CREATE",
          category: "reviewing",
          title: "BTC tends to spike on Asian session opens",
          body: "z".repeat(60),
          rationale: "y".repeat(30),
        },
      ],
      pool,
    );
    expect(r.rejected[0]?.reason).toBe("asset_mention");
  });

  test("CREATE that mentions timeframe is rejected", () => {
    const r = validateActions(
      [
        {
          type: "CREATE",
          category: "reviewing",
          title: "1h timeframe shows different behaviour than higher",
          body: "z".repeat(60),
          rationale: "y".repeat(30),
        },
      ],
      pool,
    );
    expect(r.rejected[0]?.reason).toBe("timeframe_mention");
  });

  test("DEPRECATE before CREATE in same batch frees a cap slot", () => {
    const actives = Array.from({ length: 30 }, (_, i) => ({
      ...baseLesson,
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    }));
    const fullPool: PoolSnapshot = {
      ...pool,
      activeByCategory: { detecting: [], reviewing: actives, finalizing: [] },
      pinnedById: new Map(actives.map((l) => [l.id, false])),
    };
    const targetId = actives[0]!.id;
    const actions: LessonAction[] = [
      { type: "DEPRECATE", lessonId: targetId, reason: "z".repeat(20) },
      {
        type: "CREATE",
        category: "reviewing",
        title: "New lesson after deprecate clears slot",
        body: "z".repeat(60),
        rationale: "y".repeat(30),
      },
    ];
    const r = validateActions(actions, fullPool);
    expect(r.applied).toHaveLength(2);
    expect(r.rejected).toHaveLength(0);
  });

  test("CREATE before DEPRECATE in same batch is rejected (cap not yet freed)", () => {
    const actives = Array.from({ length: 30 }, (_, i) => ({
      ...baseLesson,
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    }));
    const fullPool: PoolSnapshot = {
      ...pool,
      activeByCategory: { detecting: [], reviewing: actives, finalizing: [] },
      pinnedById: new Map(actives.map((l) => [l.id, false])),
    };
    const targetId = actives[0]!.id;
    const actions: LessonAction[] = [
      {
        type: "CREATE",
        category: "reviewing",
        title: "New lesson before deprecate fails cap",
        body: "z".repeat(60),
        rationale: "y".repeat(30),
      },
      { type: "DEPRECATE", lessonId: targetId, reason: "z".repeat(20) },
    ];
    const r = validateActions(actions, fullPool);
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0]?.type).toBe("DEPRECATE");
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.reason).toBe("cap_exceeded");
  });

  test.each<[string, AutoRejectReason]>([
    ["Bitcoin tends to spike on Asian session opens", "asset_mention"],
    ["Ethereum bouncing off resistance is reliable", "asset_mention"],
    ["DOGE pumps correlate with social signals", "asset_mention"],
    ["USDT pair correlation tightens in volatile regimes", "asset_mention"],
    ["four-hour candles show different behaviour than higher", "timeframe_mention"],
    ["fifteen-minute scalp setups need tighter SL", "timeframe_mention"],
    ["H4 chart shows a clean trend reliably", "timeframe_mention"],
    ["M15 scalps benefit from confluence here", "timeframe_mention"],
    ["The 4hr timeframe is good for swing", "timeframe_mention"],
  ])("CREATE that contains '%s' is auto-rejected with reason '%s'", (text, reason) => {
    const title = text.length >= 10 ? text : `Lesson: ${text}`;
    const body = (text + " ").repeat(8) + "y".repeat(40);
    const r = validateActions(
      [
        {
          type: "CREATE",
          category: "reviewing",
          title,
          body,
          rationale: "y".repeat(30),
        },
      ],
      pool,
    );
    expect(r.rejected[0]?.reason).toBe(reason);
  });
});
