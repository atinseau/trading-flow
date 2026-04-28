import { beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";

const runE2E = Boolean(process.env.RUN_E2E);

describe.skipIf(!runE2E)("Full pipeline E2E (real docker stack)", () => {
  // Note: assumes docker compose stack is already up via `docker compose up -d`.
  // This test does NOT bring up/down the stack — that's the operator's responsibility.
  // Prerequisite: at least one enabled watch must exist in config/watches.yaml
  // (default expected: btc-1h, override via E2E_WATCH_ID env var).

  beforeAll(async () => {
    // Verify the stack is running
    const psOutput = await $`docker compose ps --format json`.text();
    const services = psOutput
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => JSON.parse(line) as { Name: string; State: string });

    const required = ["tf-postgres", "tf-temporal", "tf-scheduler-worker", "tf-analysis-worker"];
    for (const name of required) {
      const svc = services.find((s) => s.Name === name);
      if (!svc) {
        throw new Error(`E2E precondition: ${name} not running. Run 'docker compose up -d' first.`);
      }
      if (!/running|healthy/.test(svc.State)) {
        throw new Error(
          `E2E precondition: ${name} state is ${svc.State}, expected running/healthy`,
        );
      }
    }
  }, 60_000);

  test("/health endpoints respond ok on all 3 workers", async () => {
    const ports = [8081, 8082, 8083];
    for (const port of ports) {
      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        startedAt: string;
        uptimeMs: number;
      };
      expect(["ok", "degraded"]).toContain(body.status);
      expect(body.startedAt).toBeDefined();
      expect(body.uptimeMs).toBeGreaterThan(0);
    }
  }, 30_000);

  test("force-tick on a watch creates a tick_snapshot row in Postgres", async () => {
    // Use a known watch ID from config/watches.yaml; override with E2E_WATCH_ID.
    const watchId = process.env.E2E_WATCH_ID ?? "btc-1h";

    // Capture tick_snapshots count before
    const countBefore =
      await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -tAc "SELECT COUNT(*) FROM tick_snapshots WHERE watch_id = '${watchId}'"`.text();
    const beforeCount = Number(countBefore.trim());

    // Force a tick
    await $`bun run src/cli/force-tick.ts ${watchId}`.quiet();

    // Wait up to 60s for a new tick_snapshot
    let afterCount = beforeCount;
    let attempts = 0;
    while (attempts < 60 && afterCount === beforeCount) {
      await Bun.sleep(1000);
      const out =
        await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -tAc "SELECT COUNT(*) FROM tick_snapshots WHERE watch_id = '${watchId}'"`.text();
      afterCount = Number(out.trim());
      attempts++;
    }

    expect(afterCount).toBeGreaterThan(beforeCount);
  }, 90_000);

  test("Temporal UI is reachable", async () => {
    const res = await fetch("http://localhost:8080");
    expect(res.status).toBe(200);
  }, 10_000);

  test("schedules are registered in Temporal", async () => {
    // Check that at least one Schedule exists (created by bootstrap-schedules)
    const out =
      await $`docker exec tf-temporal temporal schedule list --address temporal:7233`.text();
    expect(out).toContain("tick-"); // schedule names start with "tick-"
  }, 30_000);
});
