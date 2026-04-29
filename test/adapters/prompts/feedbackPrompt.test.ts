import { afterEach, describe, expect, test } from "bun:test";
import { clearPromptCache, loadPrompt } from "@adapters/prompts/loadPrompt";

afterEach(() => {
  clearPromptCache();
});

describe("feedback prompt", () => {
  test("loads with version feedback_v1", async () => {
    const p = await loadPrompt("feedback");
    expect(p.version).toBe("feedback_v1");
  });

  test("renders with empty existingLessons → 'first cycle'", async () => {
    const p = await loadPrompt("feedback");
    const out = p.render({
      closeOutcome: { reason: "sl_hit_direct" },
      scoreAtClose: 82,
      poolStats: { detecting: 0, reviewing: 0, finalizing: 0 },
      maxActivePerCategory: 30,
      existingLessons: [],
      contextChunks: [],
    });
    expect(out).toContain("First cycle");
  });

  test("renders existing lessons", async () => {
    const p = await loadPrompt("feedback");
    const out = p.render({
      closeOutcome: { reason: "sl_hit_direct" },
      scoreAtClose: 82,
      poolStats: { detecting: 0, reviewing: 1, finalizing: 0 },
      maxActivePerCategory: 30,
      existingLessons: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          category: "reviewing",
          timesReinforced: 2,
          title: "Sample title",
          body: "Sample body",
        },
      ],
      contextChunks: [],
    });
    expect(out).toContain("Sample title");
    expect(out).toContain("reinforced 2×");
  });
});
