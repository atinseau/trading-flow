import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WatchesConfigSchema } from "@domain/schemas/WatchesConfig";
import { parse as parseYaml } from "yaml";

test("config/watches.yaml.example parses with defaults applied", () => {
  const raw = readFileSync("config/watches.yaml.example", "utf8");
  const parsed = WatchesConfigSchema.parse(parseYaml(raw));
  expect(parsed.watches.length).toBeGreaterThan(0);
  for (const w of parsed.watches) {
    expect(w.feedback.enabled).toBe(true);
    expect(w.feedback.maxActiveLessonsPerCategory).toBe(30);
    expect(w.feedback.injection).toEqual({ detector: true, reviewer: true, finalizer: true });
    expect(w.feedback.contextProvidersDisabled).toEqual([]);
    // Notify_on extension
    expect(w.notify_on).toContain("lesson_proposed");
    expect(w.notify_on).toContain("lesson_approved");
    expect(w.notify_on).toContain("lesson_rejected");
  }
});
