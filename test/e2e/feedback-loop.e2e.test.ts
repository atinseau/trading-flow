import { beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";

const runE2E = Boolean(process.env.RUN_E2E);

/**
 * Gated e2e smoke test — exercises the feedback loop CLI surface area against
 * the real docker-compose stack. Triggering SLHit organically (price tick
 * stream) is fragile in CI, so this test focuses on the persistence + approval
 * boundary: we insert a synthetic PENDING lesson directly via psql and verify
 * the CLI can promote it to ACTIVE.
 *
 * Run with:
 *   docker compose up -d
 *   bun run test:e2e:feedback
 */
describe.skipIf(!runE2E)("feedback loop e2e (docker-compose stack)", () => {
  const watchId = process.env.E2E_WATCH_ID ?? "btc-1h";
  const lessonId = "00000000-0000-0000-0000-0000feedbacc";

  beforeAll(async () => {
    const psOutput = await $`docker compose ps --format json`.text();
    const services = psOutput
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => JSON.parse(line) as { Name: string; State: string });
    const required = ["tf-postgres", "tf-temporal"];
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

  test("insert PENDING lesson → approve via CLI → status is ACTIVE in DB", async () => {
    // Cleanup any prior state for the canary lesson id (idempotent across runs).
    await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -c "DELETE FROM lesson_events WHERE lesson_id = '${lessonId}'"`.quiet();
    await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -c "DELETE FROM lessons WHERE id = '${lessonId}'"`.quiet();

    // Seed a PENDING lesson directly. Title/body avoid asset/timeframe mentions
    // (validateActions auto-rejects those at write time, but inserts via raw
    // SQL bypass that — still, kept neutral for clarity).
    const insertSql = `
      INSERT INTO lessons (
        id, watch_id, category, status, title, body, rationale,
        prompt_version, created_at, pinned, times_reinforced, times_used_in_prompts
      ) VALUES (
        '${lessonId}',
        '${watchId}',
        'reviewing',
        'PENDING',
        'E2E canary lesson',
        'Synthetic lesson inserted by feedback-loop.e2e.test for approval flow validation.',
        'Test setup.',
        'feedback_v1',
        now(),
        false,
        0,
        0
      );
    `;
    await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -c ${insertSql}`.quiet();

    // Sanity: PENDING.
    const before =
      await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -tAc "SELECT status FROM lessons WHERE id = '${lessonId}'"`.text();
    expect(before.trim()).toBe("PENDING");

    // Approve via CLI (uses DATABASE_URL from env — caller's responsibility).
    const out = await $`bun run src/cli/approve-lesson.ts ${lessonId}`.text();
    expect(out).toContain("ACTIVE");

    const after =
      await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -tAc "SELECT status FROM lessons WHERE id = '${lessonId}'"`.text();
    expect(after.trim()).toBe("ACTIVE");

    // HumanApproved event persisted.
    const evtCount =
      await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -tAc "SELECT COUNT(*) FROM lesson_events WHERE lesson_id = '${lessonId}' AND type = 'HumanApproved'"`.text();
    expect(Number(evtCount.trim())).toBe(1);
  }, 60_000);

  // NOTE: organically triggering an SLHit close to fire the feedbackLoopWorkflow
  // child requires both a tracking setup and a price feed signal. The wiring
  // is exercised by the integration tests (feedback-loop.integration.test.ts
  // and setupWorkflow.feedback.test.ts). A fuller e2e that drives a setup
  // through Confirmed → SLHit and asserts the Temporal child workflow appears
  // would belong here once a deterministic price-tick signal injection path
  // exists in the CLI surface.
});
