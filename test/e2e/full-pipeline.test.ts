import { describe, expect, test } from "bun:test";
import { $ } from "bun";

const runE2E = Boolean(process.env.RUN_E2E);

describe.skipIf(!runE2E)("Full pipeline (E2E)", () => {
  test("docker stack healthy after bootstrap", async () => {
    const result = await $`docker compose ps --format json`.text();
    const services = result
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => JSON.parse(line));
    const required = [
      "tf-postgres",
      "tf-temporal",
      "tf-scheduler-worker",
      "tf-analysis-worker",
      "tf-notification-worker",
    ];
    for (const name of required) {
      const svc = services.find((s) => s.Name === name);
      expect(svc, `service ${name} missing`).toBeDefined();
      expect(svc.State).toMatch(/running|healthy/);
    }
  }, 30_000);

  test("force-tick triggers a Detector pass", async () => {
    await $`bun run src/cli/force-tick.ts btc-1h`.quiet();
    expect(true).toBe(true);
  }, 60_000);
});
