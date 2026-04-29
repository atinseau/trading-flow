import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WatchesConfigSchema } from "@domain/schemas/WatchesConfig";
import { parse as parseYaml } from "yaml";

test("config/watches.yaml.example parses with defaults applied", () => {
  const raw = readFileSync("config/watches.yaml.example", "utf8");
  const parsedYaml = parseYaml(raw);
  const parsed = WatchesConfigSchema.parse(parsedYaml);
  expect(parsed.watches.length).toBeGreaterThan(0);

  // Pick the first watch and assert against the literal YAML values, so silent
  // schema-key drift cannot regress (camelCase vs snake_case).
  const w = parsed.watches[0];
  if (!w) throw new Error("no watches in example");
  const yamlWatch = parsedYaml.watches[0];
  expect(w.feedback.enabled).toBe(yamlWatch.feedback.enabled);
  expect(w.feedback.max_active_lessons_per_category).toBe(
    yamlWatch.feedback.max_active_lessons_per_category,
  );
  expect(w.feedback.injection).toEqual({
    detector: yamlWatch.feedback.injection.detector,
    reviewer: yamlWatch.feedback.injection.reviewer,
    finalizer: yamlWatch.feedback.injection.finalizer,
  });
  expect(w.feedback.context_providers_disabled).toEqual(
    yamlWatch.feedback.context_providers_disabled,
  );

  for (const watch of parsed.watches) {
    // Notify_on extension
    expect(watch.notify_on).toContain("lesson_proposed");
    expect(watch.notify_on).toContain("lesson_approved");
    expect(watch.notify_on).toContain("lesson_rejected");
  }
});
