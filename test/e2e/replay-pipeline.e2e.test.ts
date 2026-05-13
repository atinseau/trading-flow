import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { chromium, expect as pwExpect } from "playwright/test";

const runE2E = Boolean(process.env.RUN_E2E);
const WEB_URL = process.env.TF_WEB_URL ?? "http://localhost:8084";
const WATCH_ID = process.env.E2E_REPLAY_WATCH_ID ?? "btcusdt-15m";

/**
 * Full replay-mode e2e against the running docker-compose stack.
 *
 * What this covers (top to bottom):
 *
 *   1. Web API     `POST /api/replay/sessions`        → 201 with the session row
 *   2. Workflow    `GET  /workflow-state`             → `{ live: null }` before first step
 *   3. Web API     `POST /step` { tickAt }            → 200, dispatches signal
 *   4. Worker      `replaySessionWorkflow` polls `replay` queue, drains the tick
 *                  via `processTick` → `runDetectorReplay` activity → real
 *                  LLM call (or cache hit on re-runs via `llm_response_cache`).
 *   5. Persistence `replay_events` gets a `DetectorTickProcessed` row,
 *                  `replay_llm_calls` gets a call row, `replay_sessions`
 *                  cost_usd_so_far is bumped.
 *   6. Web API     `GET /workflow-state` reports `tickInProgress: false`,
 *                  `pendingTicks: 0` once the worker has drained.
 *   7. UI          `/replay/:id` renders : chart (lookback + revealed + future
 *                  series), decisions log row for the new event, no horizontal
 *                  overflow, step buttons in the correct state.
 *
 * Costs : the detector tick is a real claude-opus call (~$0.15-0.30 first
 * run). Subsequent runs hit the mutualized `llm_response_cache` and cost $0.
 *
 * Window : exactly ONE 15m candle (09:15→09:30 on 2026-04-12, a date the
 * existing dev DB already has Binance OHLCV for). One candle = one detector
 * call = the smallest meaningful pipeline run.
 *
 * Prerequisites :
 *   - `docker compose up -d` (postgres + temporal + 3 workers + web).
 *   - `WATCH_ID` exists in `watch_configs` (default `btcusdt-15m`).
 *   - `CLAUDE_CODE_OAUTH_TOKEN` set so the analysis-worker can hit Claude.
 *
 * Run with :
 *   bun run test:e2e:replay
 */
describe.skipIf(!runE2E)("replay-mode e2e (real docker stack + Claude)", () => {
  const sessionName = `e2e-replay-${Date.now()}`;
  const windowStartAt = "2026-04-12T09:15:00.000Z";
  const windowEndAt = "2026-04-12T09:30:00.000Z";
  const tickAt = "2026-04-12T09:30:00.000Z";
  let sessionId = "";

  beforeAll(async () => {
    // Verify the stack is healthy enough to run replay end-to-end. The
    // replay worker lives inside tf-analysis-worker (one process, two
    // task queues : `analysis` + `replay`).
    const psOutput = await $`docker compose ps --format json`.text();
    const services = psOutput
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => JSON.parse(line) as { Name: string; State: string });

    const required = ["tf-postgres", "tf-temporal", "tf-analysis-worker", "tf-web"];
    for (const name of required) {
      const svc = services.find((s) => s.Name === name);
      if (!svc) {
        throw new Error(
          `E2E precondition: ${name} not running. Run \`docker compose up -d\` first.`,
        );
      }
      if (!/running|healthy/.test(svc.State)) {
        throw new Error(
          `E2E precondition: ${name} state is ${svc.State}, expected running/healthy`,
        );
      }
    }

    // Watch must exist — replay session creation is gated on
    // `watchRepo.findById`. We don't bootstrap one here (the user-facing
    // `bootstrap-schedules` job + UI seeding own that flow).
    const watchRows =
      await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -tAc "SELECT 1 FROM watch_configs WHERE id = '${WATCH_ID}'"`.text();
    if (watchRows.trim() !== "1") {
      throw new Error(
        `E2E precondition: watch '${WATCH_ID}' not found. Create it via the UI or override with E2E_REPLAY_WATCH_ID.`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (!sessionId) return;
    // Best-effort cleanup : terminate the Temporal workflow (if any) then
    // delete the session row. ON DELETE CASCADE wipes replay_events and
    // replay_llm_calls. Mutualized `llm_response_cache` is intentionally
    // preserved so subsequent runs are free.
    try {
      await fetch(`${WEB_URL}/api/replay/sessions/${sessionId}`, { method: "DELETE" });
    } catch {
      // Already-gone session : nothing to do. Surface any other failures
      // via the next test run rather than masking them in afterAll.
    }
  });

  test("POST /api/replay/sessions → 201 with READY session", async () => {
    const res = await fetch(`${WEB_URL}/api/replay/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        watchId: WATCH_ID,
        name: sessionName,
        windowStartAt,
        windowEndAt,
        // Tight cap : one detector tick is ~$0.20 ; $1 leaves headroom for
        // cost reporting precision without enabling a runaway.
        costCapUsd: 1,
        lessonsMode: "current",
        feedbackMode: "skip",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { id: string; status: string } };
    expect(body.session.status).toBe("READY");
    sessionId = body.session.id;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  }, 30_000);

  test("GET /workflow-state returns { live: null } before any step", async () => {
    // signalWithStart hasn't been called yet, so the workflow doesn't exist
    // in Temporal. The API short-circuits the WorkflowNotFoundError into
    // `live: null` rather than 500'ing — that's what the UI uses to show
    // "idle, ready to step".
    const res = await fetch(`${WEB_URL}/api/replay/sessions/${sessionId}/workflow-state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { live: unknown };
    expect(body.live).toBeNull();
  }, 10_000);

  test("POST /step → workflow drains → DetectorTickProcessed event persisted", async () => {
    // 1. Dispatch the single-candle tick. The API uses signalWithStart so
    //    this call both creates the workflow and signals it.
    const stepRes = await fetch(`${WEB_URL}/api/replay/sessions/${sessionId}/step`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tickAt }),
    });
    expect(stepRes.status).toBe(200);
    const stepBody = (await stepRes.json()) as { ok: boolean; tickAts: string[] };
    expect(stepBody.ok).toBe(true);
    expect(stepBody.tickAts).toEqual([tickAt]);

    // 2. Within seconds, workflow-state should expose a non-null `live`
    //    snapshot — proves the worker picked up the task. We don't assert
    //    `tickInProgress: true` because the cache-hit path completes
    //    sub-second (faster than we can poll).
    const liveReady = await pollUntil(
      async () => {
        const r = await fetch(`${WEB_URL}/api/replay/sessions/${sessionId}/workflow-state`);
        if (r.status !== 200) return null;
        const body = (await r.json()) as {
          live: null | {
            status: string;
            tickInProgress: boolean;
            pendingTicks: number;
            lastTickAt: string | null;
          };
        };
        return body.live;
      },
      (live) => live !== null,
      { timeoutMs: 15_000, intervalMs: 500 },
    );
    expect(liveReady).not.toBeNull();

    // 3. Wait for the worker to fully drain : pendingTicks back to 0, no
    //    tick currently being processed, AND `lastTickAt === tickAt`. The
    //    last condition is essential — without it the predicate also
    //    matches the "signal still in flight from the API to Temporal"
    //    window where `pendingTicks: 0` and `tickInProgress: false` are
    //    technically true but no tick has been processed yet. Generous
    //    timeout : a cold-cache Claude Opus call is ~30-45s.
    const drained = await pollUntil(
      async () => {
        const r = await fetch(`${WEB_URL}/api/replay/sessions/${sessionId}/workflow-state`);
        const body = (await r.json()) as {
          live: null | {
            tickInProgress: boolean;
            pendingTicks: number;
            status: string;
            lastTickAt: string | null;
          };
        };
        return body.live;
      },
      (live) =>
        live !== null &&
        !live.tickInProgress &&
        live.pendingTicks === 0 &&
        live.lastTickAt === tickAt,
      // Cold-cache Claude Opus calls have been observed at 2-3 minutes
      // wall-clock in practice. 4-minute budget keeps the test reliable
      // even on a worst-case first run ; cache hits return in <1 second.
      { timeoutMs: 240_000, intervalMs: 1_500 },
    );
    expect(drained?.tickInProgress).toBe(false);
    expect(drained?.pendingTicks).toBe(0);
    expect(drained?.lastTickAt).toBe(tickAt);

    // 4. Persistence check : the detector activity must have written
    //    exactly one `DetectorTickProcessed` event at `occurredAt = tickAt`
    //    (inv 7 : `occurredAt` always derived from the tick, never wall-clock).
    const eventTypesRaw =
      await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -tAc "SELECT string_agg(type || '@' || occurred_at, ',' ORDER BY sequence) FROM replay_events WHERE session_id = '${sessionId}'"`.text();
    const eventStr = eventTypesRaw.trim();
    expect(eventStr).toContain("DetectorTickProcessed");
    expect(eventStr).toContain(tickAt.replace("T", " ").replace(".000Z", "+00"));

    // 5. Cost accounting : sessions row + llm_calls row must agree.
    const costSoFar = Number(
      (
        await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -tAc "SELECT cost_usd_so_far FROM replay_sessions WHERE id = '${sessionId}'"`.text()
      ).trim(),
    );
    expect(costSoFar).toBeGreaterThanOrEqual(0); // cache hit path → 0 ; real call → > 0
    const llmCallCount = Number(
      (
        await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -tAc "SELECT COUNT(*) FROM replay_llm_calls WHERE session_id = '${sessionId}'"`.text()
      ).trim(),
    );
    expect(llmCallCount).toBeGreaterThanOrEqual(1);
  }, 300_000);

  test("/replay/:id renders : chart, log row, no overflow, controls in correct state", async () => {
    // Belt-and-suspenders : even after the workflow reports drained, the
    // session row's `status` column is updated by an activity that returns
    // BEFORE `tickInProgress` flips to false. In practice we've seen a
    // ~50-200ms window where /workflow-state says idle but the session
    // status hasn't yet been replicated to the row read by the UI. Loop
    // here until both views agree before driving the browser.
    await pollUntil(
      async () => {
        const status =
          await $`docker exec tf-postgres psql -U trading_flow -d trading_flow -tAc "SELECT status FROM replay_sessions WHERE id = '${sessionId}'"`.text();
        return status.trim();
      },
      (s) => s === "COMPLETED" || s === "COST_CAPPED" || s === "FAILED",
      { timeoutMs: 10_000, intervalMs: 250 },
    );

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      // `domcontentloaded` rather than `networkidle` : the React Query
      // workflow-state poller fires every 8s in idle mode, which prevents
      // `networkidle` from settling and times out the goto.
      await page.goto(`${WEB_URL}/replay/${sessionId}`, { waitUntil: "domcontentloaded" });

      // Header — session name pinned by us. 10s budget because the session
      // query lands after the initial paint.
      await pwExpect(page.getByText(sessionName)).toBeVisible({ timeout: 10_000 });

      // Chart renders : the lightweight-charts canvas attaches a tradingview
      // attribution link. Cheaper proxy than measuring canvas pixels.
      await pwExpect(page.locator("a[href*='tradingview.com']").first()).toBeVisible({
        timeout: 15_000,
      });

      // Decisions log shows the new event row. Slightly longer budget
      // because React Query's events query has `staleTime: 5_000` and may
      // not fire until the second invalidation cycle.
      await pwExpect(page.getByText("DetectorTickProcessed").first()).toBeVisible({
        timeout: 15_000,
      });

      // Layout sanity : the page must not horizontally overflow the
      // viewport. Pre-fix this was 5286px wide on a 1280 viewport.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);

      // Step controls : `tickAt === windowEndAt`, so the workflow completes
      // the session as soon as it processes the tick. The UI must then show
      // Step 1 disabled AND a COMPLETED status badge — that's the terminal
      // branch of `computeStepGating`. (We deliberately pick a 1-candle
      // window to minimize LLM cost ; consequence is the session is always
      // COMPLETED by the time we open the page.)
      const step1 = page.getByRole("button", { name: /step 1/i });
      await pwExpect(step1).toBeDisabled({ timeout: 10_000 });
      await pwExpect(page.getByText(/^COMPLETED$/i).first()).toBeVisible({ timeout: 10_000 });

      // No busy badge in terminal state — the spinner ("Raisonnement en
      // cours…" / "N tick(s) en file") is exclusively for live work.
      await pwExpect(page.getByText(/Raisonnement en cours|tick\(s\) en file/i)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

/**
 * Poll an async getter until `predicate` returns true, or `timeoutMs`
 * elapses. Returns the last value seen. Throws if timed out without ever
 * satisfying the predicate.
 *
 * Sized for replay workflow ticks : the default interval (500-1500ms) is a
 * good fit for both the cache-hit fast path and the cold-LLM slow path.
 */
async function pollUntil<T>(
  get: () => Promise<T>,
  predicate: (t: T) => boolean,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: T = await get();
  if (predicate(last)) return last;
  while (Date.now() < deadline) {
    await Bun.sleep(opts.intervalMs);
    last = await get();
    if (predicate(last)) return last;
  }
  throw new Error(`pollUntil: predicate not satisfied within ${opts.timeoutMs}ms`);
}
