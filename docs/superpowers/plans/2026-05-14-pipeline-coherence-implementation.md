# Pipeline Coherence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore logical coherence between the live pipeline (`setupWorkflow.ts` + `schedulerWorkflow.ts`) and the replay pipeline (`processTick.ts`) by extracting 6 shared pure functions into `src/domain/pipeline/`, then build a cross-pipeline test harness that catches future drift automatically.

**Architecture:** Pure functions take `SetupRuntimeState` + inputs, return a discriminated `{ kind, next?, event? }` result. Live workflow handlers and replay `processTick` are thin orchestrators that call the same helpers and persist the results to their respective event stores. A new `test/parity/` directory hosts the test harness with 8 canonical scenarios.

**Tech Stack:** TypeScript strict, Bun test runner, `@temporalio/testing` for live runner, in-memory adapters for replay runner.

**Spec:** `docs/superpowers/specs/2026-05-14-pipeline-coherence-design.md`

---

## File structure

**Create (new):**
- `src/domain/pipeline/timeframeToMs.ts` — re-export + ms convenience
- `src/domain/pipeline/computeTtlExpiresAt.ts`
- `src/domain/pipeline/priceInvalidationEvent.ts`
- `src/domain/pipeline/applyPriceCheck.ts`
- `src/domain/pipeline/applyCorroboration.ts`
- `src/domain/pipeline/shouldRunFeedback.ts`
- `src/domain/pipeline/index.ts` (barrel)
- `test/domain/pipeline/*.test.ts` (one per helper)
- `test/parity/types.ts`
- `test/parity/compareEvents.ts`
- `test/parity/expectEventChain.ts`
- `test/parity/runners/runLive.ts`
- `test/parity/runners/runReplay.ts`
- `test/parity/scenarios/*.scenario.ts` + matching `.test.ts` (8 pairs)

**Modify:**
- `src/workflows/scheduler/schedulerWorkflow.ts` (Drift E fix — use `computeTtlExpiresAt`)
- `src/workflows/setup/setupWorkflow.ts` (use `applyCorroboration`, `applyPriceCheck`, `buildPriceInvalidationEvent`, `shouldRunFeedback`)
- `src/workflows/setup/trackingLoop.ts` (use `buildPriceInvalidationEvent`)
- `src/workflows/replay/processTick.ts` (wire all 6 helpers + corroborations + reviewer gating)
- `package.json` (add `test:parity` script)
- `CLAUDE.md` (Pipeline coherence section)
- `README.md` (test:parity row)

---

## Task 1 — Extract `timeframeToMs` + `computeTtlExpiresAt` (fixes Drift E)

**Files:**
- Create: `src/domain/pipeline/timeframeToMs.ts`
- Create: `src/domain/pipeline/computeTtlExpiresAt.ts`
- Create: `test/domain/pipeline/computeTtlExpiresAt.test.ts`
- Modify: `src/workflows/scheduler/schedulerWorkflow.ts:189-192` (fix bug)
- Modify: `src/workflows/replay/processTick.ts:253-256`

- [ ] **Step 1: Create `timeframeToMs.ts` shared utility**

`src/domain/pipeline/timeframeToMs.ts`:

```ts
/**
 * Timeframe → milliseconds. Single source of truth for the live + replay
 * pipelines so `ttlCandles * timeframe` math agrees across both.
 * Re-exports `timeframeToMinutes` from `src/domain/replay/replaySessionRules.ts`
 * to avoid duplicating the switch statement.
 */
import { timeframeToMinutes } from "@domain/replay/replaySessionRules";
import type { Timeframe } from "@domain/schemas/WatchesConfig";

export { timeframeToMinutes } from "@domain/replay/replaySessionRules";

export function timeframeToMs(tf: Timeframe): number {
  return timeframeToMinutes(tf) * 60_000;
}
```

- [ ] **Step 2: Write failing test for `computeTtlExpiresAt`**

`test/domain/pipeline/computeTtlExpiresAt.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { computeTtlExpiresAt } from "@domain/pipeline/computeTtlExpiresAt";

describe("computeTtlExpiresAt", () => {
  const base = new Date("2026-05-14T10:00:00.000Z");

  test("1m × 50 candles = 50 min", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: base,
      ttlCandles: 50,
      primaryTimeframe: "1m",
    });
    expect(out.toISOString()).toBe("2026-05-14T10:50:00.000Z");
  });

  test("15m × 50 candles = 12h30 (NOT 50h — was the live bug)", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: base,
      ttlCandles: 50,
      primaryTimeframe: "15m",
    });
    expect(out.toISOString()).toBe("2026-05-14T22:30:00.000Z");
  });

  test("1h × 50 candles = 50h", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: base,
      ttlCandles: 50,
      primaryTimeframe: "1h",
    });
    expect(out.toISOString()).toBe("2026-05-16T12:00:00.000Z");
  });

  test("4h × 10 candles = 40h", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: base,
      ttlCandles: 10,
      primaryTimeframe: "4h",
    });
    expect(out.toISOString()).toBe("2026-05-16T02:00:00.000Z");
  });

  test("1d × 5 candles = 5 days", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: base,
      ttlCandles: 5,
      primaryTimeframe: "1d",
    });
    expect(out.toISOString()).toBe("2026-05-19T10:00:00.000Z");
  });

  test("accepts ISO string input", () => {
    const out = computeTtlExpiresAt({
      fromTickAt: "2026-05-14T10:00:00.000Z",
      ttlCandles: 4,
      primaryTimeframe: "15m",
    });
    expect(out.toISOString()).toBe("2026-05-14T11:00:00.000Z");
  });
});
```

- [ ] **Step 3: Run test, expect FAIL**

Run: `bun test test/domain/pipeline/computeTtlExpiresAt.test.ts`
Expected: 6 fail (function not found).

- [ ] **Step 4: Implement `computeTtlExpiresAt`**

`src/domain/pipeline/computeTtlExpiresAt.ts`:

```ts
import { timeframeToMs } from "./timeframeToMs";
import type { Timeframe } from "@domain/schemas/WatchesConfig";

export type ComputeTtlInput = {
  /** Base time (setup creation, or replay tick that created the setup). */
  fromTickAt: Date | string;
  ttlCandles: number;
  primaryTimeframe: Timeframe;
};

/**
 * Returns the absolute date at which a setup expires.
 *
 * Replaces the hardcoded `* 3_600_000` in `schedulerWorkflow.ts:189`
 * (assumed 1h candles regardless of timeframe — bug for non-1h watches).
 * Live and replay both call this so their TTL semantics stay in lockstep.
 */
export function computeTtlExpiresAt(input: ComputeTtlInput): Date {
  const baseMs =
    input.fromTickAt instanceof Date
      ? input.fromTickAt.getTime()
      : new Date(input.fromTickAt).getTime();
  return new Date(baseMs + input.ttlCandles * timeframeToMs(input.primaryTimeframe));
}
```

- [ ] **Step 5: Run test, expect PASS**

Run: `bun test test/domain/pipeline/computeTtlExpiresAt.test.ts`
Expected: 6 pass.

- [ ] **Step 6: Replace live usage (FIXES BUG)**

Modify `src/workflows/scheduler/schedulerWorkflow.ts` around line 189. Replace:

```ts
ttlExpiresAt: new Date(
  Date.now() + watch.setup_lifecycle.ttl_candles * 3600_000,
).toISOString(),
```

with:

```ts
ttlExpiresAt: computeTtlExpiresAt({
  fromTickAt: new Date(),
  ttlCandles: watch.setup_lifecycle.ttl_candles,
  primaryTimeframe: watch.timeframes.primary as Timeframe,
}).toISOString(),
```

Add import at top of file:

```ts
import { computeTtlExpiresAt } from "@domain/pipeline/computeTtlExpiresAt";
```

Make sure `Timeframe` import already exists or add:

```ts
import type { Timeframe } from "@domain/schemas/WatchesConfig";
```

- [ ] **Step 7: Replace replay usage**

Modify `src/workflows/replay/processTick.ts` around line 253. Find the existing TTL computation (inline `timeframeToMinutes` × 60_000) and replace with a call to `computeTtlExpiresAt`. Keep the existing import structure (the replay code already imports from `@domain/replay/replaySessionRules`).

Run a grep to confirm exact location:

```sh
grep -n "ttl_candles.*timeframeToMinutes\|ttlExpiresAt" src/workflows/replay/processTick.ts
```

Replace the matched block to use `computeTtlExpiresAt({fromTickAt: tickAtDate, ttlCandles: watch.setup_lifecycle.ttl_candles, primaryTimeframe: watch.timeframes.primary})`.

- [ ] **Step 8: Run existing live + replay test suites — no regression**

```sh
bun test test/workflows/setup test/workflows/scheduler test/workflows/replay
```

Expected: same pass/skip/fail counts as before this task (modulo the existing 5 pre-existing replay integration test failures unrelated to this work).

- [ ] **Step 9: Commit**

```bash
git add src/domain/pipeline/timeframeToMs.ts \
        src/domain/pipeline/computeTtlExpiresAt.ts \
        test/domain/pipeline/computeTtlExpiresAt.test.ts \
        src/workflows/scheduler/schedulerWorkflow.ts \
        src/workflows/replay/processTick.ts
git commit -m "feat(pipeline): extract computeTtlExpiresAt + fix live TTL bug

Drift E from the 2026-05-14 audit. Live's schedulerWorkflow hardcoded
\`* 3_600_000\` assuming 1h candles, producing wrong TTL on any non-1h
watch (15m: 4× too long, 4h: 4× too short). Replay's processTick was
correct. Extracting to a shared helper fixes the live bug and pins
both pipelines on a single source of truth.

Also factor a tiny \`timeframeToMs\` wrapper re-exporting the existing
\`timeframeToMinutes\` switch so any future pipeline math uses it."
```

---

## Task 2 — Extract `buildPriceInvalidationEvent` (fixes Drift C)

**Files:**
- Create: `src/domain/pipeline/priceInvalidationEvent.ts`
- Create: `test/domain/pipeline/priceInvalidationEvent.test.ts`
- Modify: `src/workflows/setup/setupWorkflow.ts` (priceCheckSignal handler — use builder)
- Modify: `src/workflows/setup/trackingLoop.ts` (use builder)
- Modify: `src/workflows/replay/processTick.ts` (TRACKING-time invalidation event type alignment)

- [ ] **Step 1: Write failing test**

`test/domain/pipeline/priceInvalidationEvent.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildPriceInvalidationEvent } from "@domain/pipeline/priceInvalidationEvent";

describe("buildPriceInvalidationEvent", () => {
  const baseState = {
    status: "REVIEWING" as const,
    score: 42,
    invalidationLevel: 50_000,
    direction: "LONG" as const,
  };

  test("trigger='price_monitor' (live REVIEWING/FINALIZING)", () => {
    const evt = buildPriceInvalidationEvent({
      state: baseState,
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:30:00.000Z",
      trigger: "price_monitor",
    });
    expect(evt.type).toBe("PriceInvalidated");
    expect(evt.stage).toBe("system");
    expect(evt.actor).toBe("price_monitor");
    expect(evt.scoreDelta).toBe(0);
    expect(evt.scoreAfter).toBe(42);
    expect(evt.statusBefore).toBe("REVIEWING");
    expect(evt.statusAfter).toBe("INVALIDATED");
    expect(evt.payload.type).toBe("PriceInvalidated");
    expect(evt.payload.data).toMatchObject({
      currentPrice: 49_500,
      invalidationLevel: 50_000,
      observedAt: "2026-05-14T10:30:00.000Z",
    });
  });

  test("trigger='tracker' (TRACKING-time invalidation)", () => {
    const evt = buildPriceInvalidationEvent({
      state: { ...baseState, status: "TRACKING" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T11:00:00.000Z",
      trigger: "tracker",
    });
    expect(evt.actor).toBe("tracker");
    expect(evt.statusBefore).toBe("TRACKING");
    expect(evt.statusAfter).toBe("INVALIDATED");
    expect(evt.type).toBe("PriceInvalidated");
  });

  test("preserves scoreAfter from state.score regardless of trigger", () => {
    const evt = buildPriceInvalidationEvent({
      state: { ...baseState, score: 73 },
      currentPrice: 49_000,
      observedAt: "2026-05-14T10:00:00.000Z",
      trigger: "price_monitor",
    });
    expect(evt.scoreAfter).toBe(73);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `bun test test/domain/pipeline/priceInvalidationEvent.test.ts`
Expected: 3 fail.

- [ ] **Step 3: Implement `buildPriceInvalidationEvent`**

`src/domain/pipeline/priceInvalidationEvent.ts`:

```ts
import type { PriceInvalidatedPayload } from "@domain/events/schemas";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type SetupRuntimeState = {
  status: SetupStatus;
  score: number;
  invalidationLevel: number;
  direction: "LONG" | "SHORT";
};

export type PriceInvalidationEventInput = {
  state: SetupRuntimeState;
  currentPrice: number;
  observedAt: string; // ISO
  /** `price_monitor` for live's REVIEWING/FINALIZING priceCheckSignal,
   *  `tracker` for the intra-candle simulator (replay) or trackingLoop (live). */
  trigger: "price_monitor" | "tracker";
};

export type PriceInvalidationEvent = {
  stage: "system";
  actor: "price_monitor" | "tracker";
  type: "PriceInvalidated";
  scoreDelta: 0;
  scoreAfter: number;
  statusBefore: SetupStatus;
  statusAfter: "INVALIDATED";
  payload: { type: "PriceInvalidated"; data: PriceInvalidatedPayload };
};

/**
 * Canonical builder for the `PriceInvalidated` event. Used by:
 * - Live: `setupWorkflow.priceCheckSignal` (REVIEWING/FINALIZING) and `trackingLoop` (TRACKING).
 * - Replay: `processTick` REVIEWING phase (added in Task 5) and the intra-candle simulator.
 *
 * Drift C resolution: replay previously emitted `type: "Invalidated"` for
 * tracker-time invalidations. Canonical is `PriceInvalidated` (live's name).
 */
export function buildPriceInvalidationEvent(
  input: PriceInvalidationEventInput,
): PriceInvalidationEvent {
  return {
    stage: "system",
    actor: input.trigger,
    type: "PriceInvalidated",
    scoreDelta: 0,
    scoreAfter: input.state.score,
    statusBefore: input.state.status,
    statusAfter: "INVALIDATED",
    payload: {
      type: "PriceInvalidated",
      data: {
        currentPrice: input.currentPrice,
        invalidationLevel: input.state.invalidationLevel,
        observedAt: input.observedAt,
      },
    },
  };
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `bun test test/domain/pipeline/priceInvalidationEvent.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Replace live usage in `setupWorkflow.priceCheckSignal`**

Modify `src/workflows/setup/setupWorkflow.ts` around line 297-321. Find the inline event construction in the priceCheck handler and replace with `buildPriceInvalidationEvent(...)`. Preserve the state-before-await race fix (mutate `state.status = "INVALIDATED"` BEFORE the await). Keep the inputHash-less persistEvent call structure intact — just swap the event-builder portion.

Add import:

```ts
import { buildPriceInvalidationEvent } from "@domain/pipeline/priceInvalidationEvent";
```

Replace lines 297-321 (the existing inline `{ event: { stage: "system", actor: "price_monitor", type: "PriceInvalidated", ... }, setupUpdate: {...} }`) with:

```ts
const event = buildPriceInvalidationEvent({
  state: {
    status: before.status,
    score: before.score,
    invalidationLevel: state.invalidationLevel,
    direction: state.direction,
  },
  currentPrice: args.currentPrice,
  observedAt: args.observedAt,
  trigger: "price_monitor",
});
const stored = await dbActivities.persistEvent({
  event: { setupId: initial.setupId, ...event },
  setupUpdate: {
    score: event.scoreAfter,
    status: event.statusAfter,
    invalidationLevel: state.invalidationLevel,
  },
});
```

- [ ] **Step 6: Replace live usage in `trackingLoop`**

Modify `src/workflows/setup/trackingLoop.ts` around line 108-122. Find the `PriceInvalidated` event construction in the tracking-loop's price-breach branch and replace with:

```ts
const event = buildPriceInvalidationEvent({
  state: { status: "TRACKING", score: state.score, invalidationLevel: args.invalidationLevel, direction: args.direction },
  currentPrice: tickPrice,
  observedAt,
  trigger: "tracker",
});
await dbActivities.persistEvent({
  event: { setupId: args.setupId, ...event },
  setupUpdate: { score: event.scoreAfter, status: "INVALIDATED", invalidationLevel: args.invalidationLevel },
});
```

Add the import at top of file. Keep all surrounding logic (return reason="price_invalidated", etc.) intact.

- [ ] **Step 7: Replace replay usage (canonical event type alignment)**

Modify `src/workflows/replay/processTick.ts` around line 597-628. Find the `type: "Invalidated"` event construction in the tracker-time invalidation branch. Replace with `buildPriceInvalidationEvent(..., trigger: "tracker")`.

```sh
grep -n "type: \"Invalidated\"" src/workflows/replay/processTick.ts
```

Replace each matched block. The replay's `setupUpdate` shape may have slight differences — preserve the surrounding adapter call (`appendReplayEvent`).

- [ ] **Step 8: Run regression suites**

```sh
bun test test/workflows/setup test/workflows/replay
bun test test/domain/events/payloadAccessors.test.ts
```

Expected: same as before.

- [ ] **Step 9: Commit**

```bash
git add src/domain/pipeline/priceInvalidationEvent.ts \
        test/domain/pipeline/priceInvalidationEvent.test.ts \
        src/workflows/setup/setupWorkflow.ts \
        src/workflows/setup/trackingLoop.ts \
        src/workflows/replay/processTick.ts
git commit -m "feat(pipeline): canonical PriceInvalidated event builder

Drift C from the 2026-05-14 audit. Live emitted \`PriceInvalidated\` for
both priceCheck (REVIEWING/FINALIZING breach) and trackingLoop
(TRACKING-time breach). Replay emitted \`Invalidated\` for the
tracker-time breach, breaking event-type parity for the same logical
situation. Canonical is now \`PriceInvalidated\` (live's name) via a
shared builder. Replay tracker invalidation now produces the same
event type as live."
```

---

## Task 3 — Extract `shouldRunFeedback` (fixes Drift G)

**Files:**
- Create: `src/domain/pipeline/shouldRunFeedback.ts`
- Create: `test/domain/pipeline/shouldRunFeedback.test.ts`
- Modify: `src/workflows/setup/setupWorkflow.ts:693-714`
- Modify: `src/workflows/replay/activities.ts:839-851` (runFeedbackAnalysisReplay gate)

- [ ] **Step 1: Write failing test**

`test/domain/pipeline/shouldRunFeedback.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { shouldRunFeedback } from "@domain/pipeline/shouldRunFeedback";

const slHitDirect = { reason: "sl_hit_direct" as const, everConfirmed: true };
const allTpsHit = { reason: "all_tps_hit" as const, everConfirmed: true };
const expired = { reason: "expired" as const, everConfirmed: false };

describe("shouldRunFeedback", () => {
  test("SL hit + watch enabled + no session mode (live default) → true", () => {
    expect(
      shouldRunFeedback({
        closeOutcome: slHitDirect,
        watchFeedbackEnabled: true,
      }),
    ).toBe(true);
  });

  test("All TPs hit (winner) → false even when everything else enabled", () => {
    expect(
      shouldRunFeedback({
        closeOutcome: allTpsHit,
        watchFeedbackEnabled: true,
      }),
    ).toBe(false);
  });

  test("Expired (never confirmed) → false", () => {
    expect(
      shouldRunFeedback({
        closeOutcome: expired,
        watchFeedbackEnabled: true,
      }),
    ).toBe(false);
  });

  test("SL hit + watch DISABLED → false (Drift G fix)", () => {
    expect(
      shouldRunFeedback({
        closeOutcome: slHitDirect,
        watchFeedbackEnabled: false,
      }),
    ).toBe(false);
  });

  test("SL hit + watch enabled + session mode='skip' → false (replay override)", () => {
    expect(
      shouldRunFeedback({
        closeOutcome: slHitDirect,
        watchFeedbackEnabled: true,
        sessionFeedbackMode: "skip",
      }),
    ).toBe(false);
  });

  test("SL hit + watch enabled + session mode='run' → true", () => {
    expect(
      shouldRunFeedback({
        closeOutcome: slHitDirect,
        watchFeedbackEnabled: true,
        sessionFeedbackMode: "run",
      }),
    ).toBe(true);
  });

  test("SL hit + watch disabled + session mode='run' → false (watch wins)", () => {
    expect(
      shouldRunFeedback({
        closeOutcome: slHitDirect,
        watchFeedbackEnabled: false,
        sessionFeedbackMode: "run",
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```sh
bun test test/domain/pipeline/shouldRunFeedback.test.ts
```
Expected: 7 fail.

- [ ] **Step 3: Implement `shouldRunFeedback`**

`src/domain/pipeline/shouldRunFeedback.ts`:

```ts
import { type CloseOutcome, shouldTriggerFeedback } from "@domain/feedback/closeOutcome";

export type ShouldRunFeedbackInput = {
  closeOutcome: CloseOutcome;
  /** From `watch.feedback.enabled`, snapshotted into InitialEvidence at setup
   *  creation so concurrent watch edits can't retroactively flip a setup's
   *  feedback fate. */
  watchFeedbackEnabled: boolean;
  /** Replay-only: `"run"` (default) or `"skip"`. Undefined in live. */
  sessionFeedbackMode?: "run" | "skip";
};

/**
 * Unified gate for the feedback loop. Live and replay must agree on when
 * the feedbackLoopWorkflow / runFeedbackAnalysisReplay fires.
 *
 * Drift G: replay used to gate only on sessionFeedbackMode, ignoring
 * `watch.feedback.enabled`. A watch with feedback turned off was still
 * producing lesson proposals in replay sessions.
 */
export function shouldRunFeedback(input: ShouldRunFeedbackInput): boolean {
  if (!input.watchFeedbackEnabled) return false;
  if ((input.sessionFeedbackMode ?? "run") === "skip") return false;
  return shouldTriggerFeedback(input.closeOutcome);
}
```

- [ ] **Step 4: Run test, expect PASS**

```sh
bun test test/domain/pipeline/shouldRunFeedback.test.ts
```
Expected: 7 pass.

- [ ] **Step 5: Wire in live (`setupWorkflow.ts`)**

Modify `src/workflows/setup/setupWorkflow.ts` around line 693-714. Find:

```ts
if (initial.feedbackEnabled) {
  const closeOutcome = deriveCloseOutcome(...);
  if (shouldTriggerFeedback(closeOutcome)) {
    await startChild(feedbackLoopWorkflow, ...);
  }
}
```

Replace with:

```ts
const closeOutcome = deriveCloseOutcome({
  finalStatus: "CLOSED",
  trackingResult,
  everConfirmed: true,
});
if (
  shouldRunFeedback({
    closeOutcome,
    watchFeedbackEnabled: initial.feedbackEnabled,
    // No sessionFeedbackMode in live.
  })
) {
  await startChild(feedbackLoopWorkflow, ...);
}
```

Add import:
```ts
import { shouldRunFeedback } from "@domain/pipeline/shouldRunFeedback";
```

Remove the now-unused `shouldTriggerFeedback` import if no other call site uses it (grep first).

- [ ] **Step 6: Wire in replay (`runFeedbackAnalysisReplay` activity)**

Modify `src/workflows/replay/activities.ts` around line 839-851. Find the existing feedback gate (currently checks `session.feedbackMode === "skip"`). Replace with:

```ts
if (
  !shouldRunFeedback({
    closeOutcome: input.closeOutcome,
    watchFeedbackEnabled: session.configSnapshot.feedback?.enabled ?? true,
    sessionFeedbackMode: session.feedbackMode,
  })
) {
  return {
    skipped: true,
    summary: "",
    actions: [],
    costUsd: 0,
    promptVersion: "",
    provider: "",
    model: "",
    cacheHit: false,
  };
}
```

Add the import. The `session.configSnapshot` is already in scope in `runFeedbackAnalysisReplay`.

- [ ] **Step 7: Run regression suites**

```sh
bun test test/workflows/setup test/workflows/replay
```
Expected: same pass/fail counts as before.

- [ ] **Step 8: Commit**

```bash
git add src/domain/pipeline/shouldRunFeedback.ts \
        test/domain/pipeline/shouldRunFeedback.test.ts \
        src/workflows/setup/setupWorkflow.ts \
        src/workflows/replay/activities.ts
git commit -m "feat(pipeline): unified shouldRunFeedback gate

Drift G from the 2026-05-14 audit. Live combined \`watch.feedback.enabled\`
(snapshotted into InitialEvidence) with \`shouldTriggerFeedback(outcome)\`.
Replay only checked \`session.feedbackMode === \"skip\"\` and ignored
the watch flag, producing FeedbackLessonProposed events on watches that
had feedback explicitly disabled.

Helper combines all three: watch flag (snapshotted), session override
(replay-only), and outcome eligibility (sl_hit_*, price_invalidated)."
```

---

## Task 4 — Extract `applyCorroboration` (fixes Drift A — the big one)

**Files:**
- Create: `src/domain/pipeline/applyCorroboration.ts`
- Create: `test/domain/pipeline/applyCorroboration.test.ts`
- Modify: `src/workflows/setup/setupWorkflow.ts:244-324` (corroborateSignal handler)
- Modify: `src/workflows/replay/processTick.ts:181-330` (phase 2 — consume corroborations)

- [ ] **Step 1: Write failing test (12 cases — truth table from spec)**

`test/domain/pipeline/applyCorroboration.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { applyCorroboration } from "@domain/pipeline/applyCorroboration";

const baseState = {
  status: "REVIEWING" as const,
  score: 33,
  invalidationLevel: 50_000,
  direction: "LONG" as const,
};

const baseScoring = {
  scoreMax: 100,
  scoreThresholdFinalizer: 80,
  scoreThresholdDead: 10,
};

describe("applyCorroboration", () => {
  test("delta=0 → noop", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: 0,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("noop");
  });

  test("delta=+5 REVIEWING → Strengthened, score 33→38, status unchanged", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: 5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.event.type).toBe("Strengthened");
    expect(r.event.scoreDelta).toBe(5);
    expect(r.event.scoreAfter).toBe(38);
    expect(r.event.statusAfter).toBe("REVIEWING");
    expect(r.next.score).toBe(38);
    expect(r.event.payload).toMatchObject({
      type: "Strengthened",
      data: { source: "detector_corroboration" },
    });
  });

  test("delta=+50 clamps to scoreMax=80 (no overshoot)", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: 50,
      scoring: { ...baseScoring, scoreMax: 80 },
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.next.score).toBe(80);
    expect(r.event.scoreDelta).toBe(47); // 80 - 33
  });

  test("crosses scoreThresholdFinalizer → status FINALIZING", () => {
    const r = applyCorroboration({
      state: { ...baseState, score: 75 },
      delta: 10,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.event.statusAfter).toBe("FINALIZING");
    expect(r.next.status).toBe("FINALIZING");
  });

  test("delta=-5 REVIEWING → Weakened, score 33→28", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: -5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.event.type).toBe("Weakened");
    expect(r.event.scoreDelta).toBe(-5);
    expect(r.event.scoreAfter).toBe(28);
    expect(r.event.payload).toMatchObject({
      type: "Weakened",
      data: { source: "detector_decorroboration" },
    });
  });

  test("delta=-50 floors to 0", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: -50,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.next.score).toBe(0);
    expect(r.event.scoreDelta).toBe(-33);
  });

  test("score crosses ≤scoreThresholdDead → EXPIRED", () => {
    const r = applyCorroboration({
      state: { ...baseState, score: 15 },
      delta: -5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.event.statusAfter).toBe("EXPIRED");
    expect(r.next.status).toBe("EXPIRED");
  });

  test("status FINALIZING → ignored", () => {
    const r = applyCorroboration({
      state: { ...baseState, status: "FINALIZING" },
      delta: 5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("ignored");
  });

  test("status TRACKING → ignored", () => {
    const r = applyCorroboration({
      state: { ...baseState, status: "TRACKING" },
      delta: -10,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("ignored");
  });

  test("status REJECTED → ignored", () => {
    const r = applyCorroboration({
      state: { ...baseState, status: "REJECTED" },
      delta: 5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("ignored");
  });

  test("event carries detectorPromptVersion as actor", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: 5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v7",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.event.actor).toBe("detector_v7");
    expect(r.event.stage).toBe("detector");
  });

  test("preserves invalidationLevel and direction in next", () => {
    const r = applyCorroboration({
      state: baseState,
      delta: 5,
      scoring: baseScoring,
      detectorPromptVersion: "detector_v6",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.next.invalidationLevel).toBe(50_000);
    expect(r.next.direction).toBe("LONG");
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```sh
bun test test/domain/pipeline/applyCorroboration.test.ts
```
Expected: 12 fail.

- [ ] **Step 3: Implement `applyCorroboration`**

`src/domain/pipeline/applyCorroboration.ts`:

```ts
import type {
  StrengthenedPayload,
  WeakenedPayload,
} from "@domain/events/schemas";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type SetupRuntimeState = {
  status: SetupStatus;
  score: number;
  invalidationLevel: number;
  direction: "LONG" | "SHORT";
};

export type ScoringConfig = {
  scoreMax: number;
  scoreThresholdFinalizer: number;
  scoreThresholdDead: number;
};

export type CorroborationInput = {
  state: SetupRuntimeState;
  /** Signed delta, `[-20, 20]` per `DetectorOutput.confidence_delta_suggested`. */
  delta: number;
  scoring: ScoringConfig;
  detectorPromptVersion: string;
};

export type CorroborationResult =
  | { kind: "noop" }
  | { kind: "ignored" }
  | {
      kind: "applied";
      next: SetupRuntimeState;
      event: {
        stage: "detector";
        actor: string;
        type: "Strengthened" | "Weakened";
        scoreDelta: number;
        scoreAfter: number;
        statusBefore: SetupStatus;
        statusAfter: SetupStatus;
        payload:
          | { type: "Strengthened"; data: StrengthenedPayload }
          | { type: "Weakened"; data: WeakenedPayload };
      };
    };

const STRENGTHENED_REASONING = "Corroborating evidence from detector";
const WEAKENED_REASONING =
  "Detector observes pattern weakening or no longer visible on chart";

/**
 * Apply a detector corroboration signal to an alive setup.
 *
 * Shared by `setupWorkflow.corroborateSignal` (live) and `processTick.ts`
 * phase 2 (replay). Drift A from the 2026-05-14 audit: replay used to
 * destructure only `new_setups` from the detector verdict and silently
 * drop `corroborations[]`, leaving score trajectories divergent from live
 * the moment the detector emitted a corroboration. With this helper, both
 * pipelines run the same scoring + state transitions.
 *
 * Sémantique :
 * - `delta === 0`               → noop (caller doesn't persist).
 * - `state.status !== "REVIEWING"` → ignored.
 * - `newScore = clamp(score + delta, [0, scoreMax])` (floor + ceiling).
 * - `delta > 0`                 → `Strengthened` event,
 *   `payload.data.source = "detector_corroboration"`.
 * - `delta < 0`                 → `Weakened` event,
 *   `payload.data.source = "detector_decorroboration"`.
 * - `newScore >= threshold`     → `statusAfter = "FINALIZING"`.
 * - `newScore <= dead`          → `statusAfter = "EXPIRED"`.
 */
export function applyCorroboration(input: CorroborationInput): CorroborationResult {
  if (input.delta === 0) return { kind: "noop" };
  if (input.state.status !== "REVIEWING") return { kind: "ignored" };

  const rawScore = input.state.score + input.delta;
  const newScore = Math.max(0, Math.min(input.scoring.scoreMax, rawScore));
  const actualDelta = newScore - input.state.score;

  let newStatus: SetupStatus = "REVIEWING";
  if (newScore >= input.scoring.scoreThresholdFinalizer) {
    newStatus = "FINALIZING";
  } else if (newScore <= input.scoring.scoreThresholdDead) {
    newStatus = "EXPIRED";
  }

  const next: SetupRuntimeState = {
    status: newStatus,
    score: newScore,
    invalidationLevel: input.state.invalidationLevel,
    direction: input.state.direction,
  };

  const isStrengthen = input.delta > 0;

  return {
    kind: "applied",
    next,
    event: {
      stage: "detector",
      actor: input.detectorPromptVersion,
      type: isStrengthen ? "Strengthened" : "Weakened",
      scoreDelta: actualDelta,
      scoreAfter: newScore,
      statusBefore: input.state.status,
      statusAfter: newStatus,
      payload: isStrengthen
        ? {
            type: "Strengthened",
            data: {
              reasoning: STRENGTHENED_REASONING,
              observations: [],
              source: "detector_corroboration",
            },
          }
        : {
            type: "Weakened",
            data: {
              reasoning: WEAKENED_REASONING,
              observations: [],
              source: "detector_decorroboration",
            },
          },
    },
  };
}
```

- [ ] **Step 4: Run test, expect PASS**

```sh
bun test test/domain/pipeline/applyCorroboration.test.ts
```
Expected: 12 pass.

- [ ] **Step 5: Replace live's corroborateSignal handler**

Modify `src/workflows/setup/setupWorkflow.ts` around line 244-324. The current handler does all the math inline and emits the event. Replace with:

```ts
setHandler(corroborateSignal, async (args) => {
  const result = applyCorroboration({
    state: {
      status: state.status,
      score: state.score,
      invalidationLevel: state.invalidationLevel,
      direction: state.direction,
    },
    delta: args.confidenceDelta,
    scoring: {
      scoreMax: initial.scoreMax,
      scoreThresholdFinalizer: initial.scoreThresholdFinalizer,
      scoreThresholdDead: initial.scoreThresholdDead,
    },
    detectorPromptVersion: initial.detectorPromptVersion,
  });

  if (result.kind !== "applied") return;

  // RACE FIX (preserved from prior commit): mutate state BEFORE the persist
  // await so concurrent signal handlers observe the new state via the
  // synchronous `state.status` read.
  state.score = result.next.score;
  state.status = result.next.status;

  const stored = await dbActivities.persistEvent({
    event: { setupId: initial.setupId, ...result.event },
    setupUpdate: {
      score: result.next.score,
      status: result.next.status,
      invalidationLevel: state.invalidationLevel,
    },
  });
  state.sequence = stored.sequence;
});
```

Add import:
```ts
import { applyCorroboration } from "@domain/pipeline/applyCorroboration";
```

- [ ] **Step 6: Wire corroborations into replay's `processTick.ts`**

Modify `src/workflows/replay/processTick.ts` around line 181-200. Find where the detector verdict is destructured (currently only `new_setups`). Update to also consume `corroborations`:

```ts
const detVerdict = JSON.parse(detectorResult.verdictJson) as {
  new_setups: unknown[];
  corroborations: Array<{
    setup_id: string;
    evidence: string[];
    confidence_delta_suggested: number;
  }>;
  ignore_reason?: string | null;
};

// --- Phase 2a: apply detector corroborations to alive setups ---
const corroboratedIds = new Set<string>();
for (const corr of detVerdict.corroborations ?? []) {
  const setup = alive.get(corr.setup_id);
  if (!setup) continue; // setup may have terminated between ticks
  corroboratedIds.add(corr.setup_id);

  const result = applyCorroboration({
    state: setup.runtime,
    delta: corr.confidence_delta_suggested,
    scoring: {
      scoreMax: watch.setup_lifecycle.score_max,
      scoreThresholdFinalizer: watch.setup_lifecycle.score_threshold_finalizer,
      scoreThresholdDead: watch.setup_lifecycle.score_threshold_dead,
    },
    detectorPromptVersion: detectorResult.promptVersion,
  });

  if (result.kind !== "applied") continue;
  setup.runtime = result.next;

  await db.appendReplayEvent({
    sessionId,
    event: {
      setupId: setup.id,
      occurredAt: new Date(tickAt),
      ...result.event,
    },
  });

  // If the corroboration drove the setup to a terminal status, remove from alive.
  if (result.next.status === "EXPIRED") {
    alive.delete(setup.id);
  }
}
```

The exact line number and surrounding code may differ — read processTick.ts carefully and integrate the loop in the right phase order: detector → dedup → corroborations → new setup creation → reviewer (gated by `corroboratedIds`).

Add import:
```ts
import { applyCorroboration } from "@domain/pipeline/applyCorroboration";
```

- [ ] **Step 7: Run regression suites**

```sh
bun test test/workflows/setup test/workflows/replay
```
Expected: 0 regression. The existing replay processTick tests stub `corroborations: []` so they continue to no-op cleanly.

- [ ] **Step 8: Commit**

```bash
git add src/domain/pipeline/applyCorroboration.ts \
        test/domain/pipeline/applyCorroboration.test.ts \
        src/workflows/setup/setupWorkflow.ts \
        src/workflows/replay/processTick.ts
git commit -m "feat(pipeline): shared applyCorroboration — replay reads corroborations now

Drift A from the 2026-05-14 audit. The fix for bidirectional detector
corroboration shipped in b9615b4 added the negative-delta + floor +
EXPIRED transition to the live \`corroborateSignal\` handler, but
replay's \`processTick.ts\` never destructured \`verdict.corroborations[]\`
to begin with — it consumed only \`new_setups\`. Replay score
trajectories diverged from live the moment the detector corroborated
anything.

Extract the corroboration math into a pure helper consumed by both
pipelines. Live's signal handler becomes a thin wrapper. Replay's
processTick gains a phase-2a corroboration loop that produces the same
Strengthened / Weakened events with the same source discriminant."
```

---

## Task 5 — Extract `applyPriceCheck` (fixes Drift D)

**Files:**
- Create: `src/domain/pipeline/applyPriceCheck.ts`
- Create: `test/domain/pipeline/applyPriceCheck.test.ts`
- Modify: `src/workflows/setup/setupWorkflow.ts:283-391` (priceCheckSignal handler — use helper)
- Modify: `src/workflows/replay/processTick.ts` (add phase 0.5 — REVIEWING/FINALIZING price breach check)

- [ ] **Step 1: Write failing test**

`test/domain/pipeline/applyPriceCheck.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { applyPriceCheck } from "@domain/pipeline/applyPriceCheck";

const baseLong = {
  status: "REVIEWING" as const,
  score: 42,
  invalidationLevel: 50_000,
  direction: "LONG" as const,
};

describe("applyPriceCheck", () => {
  test("LONG breach (price < invalidation) in REVIEWING → applied", () => {
    const r = applyPriceCheck({
      state: baseLong,
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(r.next.status).toBe("INVALIDATED");
    expect(r.event.type).toBe("PriceInvalidated");
    expect(r.event.actor).toBe("price_monitor");
  });

  test("LONG breach in FINALIZING → applied", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, status: "FINALIZING" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("applied");
  });

  test("LONG no breach (price >= invalidation) → not_breached", () => {
    const r = applyPriceCheck({
      state: baseLong,
      currentPrice: 50_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_breached");
  });

  test("LONG equal to invalidation level → not_breached (strict less-than)", () => {
    const r = applyPriceCheck({
      state: baseLong,
      currentPrice: 50_000,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_breached");
  });

  test("SHORT breach (price > invalidation) → applied", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, direction: "SHORT" },
      currentPrice: 50_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("applied");
  });

  test("SHORT no breach → not_breached", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, direction: "SHORT" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_breached");
  });

  test("status TRACKING → not_active (trackingLoop handles)", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, status: "TRACKING" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_active");
  });

  test("status INVALIDATED (terminal) → not_active", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, status: "INVALIDATED" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_active");
  });

  test("status CLOSED (terminal) → not_active", () => {
    const r = applyPriceCheck({
      state: { ...baseLong, status: "CLOSED" },
      currentPrice: 49_500,
      observedAt: "2026-05-14T10:00:00.000Z",
    });
    expect(r.kind).toBe("not_active");
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```sh
bun test test/domain/pipeline/applyPriceCheck.test.ts
```
Expected: 9 fail.

- [ ] **Step 3: Implement `applyPriceCheck`**

`src/domain/pipeline/applyPriceCheck.ts`:

```ts
import {
  buildPriceInvalidationEvent,
  type PriceInvalidationEvent,
  type SetupRuntimeState,
} from "./priceInvalidationEvent";

export type PriceCheckInput = {
  state: SetupRuntimeState;
  currentPrice: number;
  observedAt: string;
};

export type PriceCheckResult =
  | { kind: "not_breached" }
  | { kind: "not_active" } // TRACKING (handled elsewhere) or terminal
  | {
      kind: "applied";
      next: SetupRuntimeState;
      event: PriceInvalidationEvent;
    };

/**
 * Apply a REVIEWING/FINALIZING-phase price-breach check.
 *
 * Live uses this in `setupWorkflow.priceCheckSignal`. Replay uses it in a
 * new phase 0.5 of `processTick.ts` (Drift D fix — replay previously had
 * no REVIEWING-time price-breach check, so setups whose price moved
 * through the invalidation level between detector ticks were never
 * invalidated by replay, only via TTL).
 *
 * TRACKING-phase is handled separately by `trackingLoop` (live) /
 * `simulateCandleTracking` (replay) which simulate intra-candle prices.
 */
export function applyPriceCheck(input: PriceCheckInput): PriceCheckResult {
  if (input.state.status === "TRACKING") return { kind: "not_active" };
  if (input.state.status !== "REVIEWING" && input.state.status !== "FINALIZING") {
    return { kind: "not_active" };
  }

  const breached =
    (input.state.direction === "LONG" && input.currentPrice < input.state.invalidationLevel) ||
    (input.state.direction === "SHORT" && input.currentPrice > input.state.invalidationLevel);
  if (!breached) return { kind: "not_breached" };

  const event = buildPriceInvalidationEvent({
    state: input.state,
    currentPrice: input.currentPrice,
    observedAt: input.observedAt,
    trigger: "price_monitor",
  });

  return {
    kind: "applied",
    next: { ...input.state, status: "INVALIDATED" },
    event,
  };
}
```

- [ ] **Step 4: Run test, expect PASS**

```sh
bun test test/domain/pipeline/applyPriceCheck.test.ts
```
Expected: 9 pass.

- [ ] **Step 5: Replace live's priceCheckSignal handler**

Modify `src/workflows/setup/setupWorkflow.ts` around line 283-391. Replace the handler body with:

```ts
setHandler(priceCheckSignal, async (args) => {
  const result = applyPriceCheck({
    state: {
      status: state.status,
      score: state.score,
      invalidationLevel: state.invalidationLevel,
      direction: state.direction,
    },
    currentPrice: args.currentPrice,
    observedAt: args.observedAt,
  });
  if (result.kind !== "applied") return;

  // RACE FIX: mutate before await.
  state.status = result.next.status;

  const stored = await dbActivities.persistEvent({
    event: { setupId: initial.setupId, ...result.event },
    setupUpdate: {
      score: result.next.score,
      status: result.next.status,
      invalidationLevel: state.invalidationLevel,
    },
  });
  state.sequence = stored.sequence;

  if (everConfirmed) {
    await notifyActivities.notifyTelegramInvalidatedAfterConfirmed({
      watchId: initial.watchId,
      asset: initial.asset,
      timeframe: initial.timeframe,
      reason: "price_below_invalidation",
    });
  }
});
```

Add import:
```ts
import { applyPriceCheck } from "@domain/pipeline/applyPriceCheck";
```

- [ ] **Step 6: Add phase 0.5 to replay's `processTick.ts`**

In `processTick.ts`, before the detector phase (phase 1), add a new phase that checks each alive REVIEWING/FINALIZING setup against the candle's low/high :

```ts
// --- Phase 0.5: REVIEWING/FINALIZING price-breach check ---
// Mirrors live's priceCheckSignal handler. The replay's "current price"
// for breach detection is the worst-case intra-candle level: candle.low
// for LONG setups (lowest price during the candle), candle.high for SHORT.
// If breached, invalidate immediately so subsequent phases see the
// terminated state.
for (const [setupId, setup] of [...alive]) {
  const worstPrice =
    setup.runtime.direction === "LONG" ? candle.low : candle.high;
  const result = applyPriceCheck({
    state: setup.runtime,
    currentPrice: worstPrice,
    observedAt: candle.timestamp,
  });
  if (result.kind !== "applied") continue;
  setup.runtime = result.next;
  await db.appendReplayEvent({
    sessionId,
    event: {
      setupId,
      occurredAt: new Date(tickAt),
      ...result.event,
    },
  });
  alive.delete(setupId);
}
```

The exact `candle` variable name + `db.appendReplayEvent` call signature may differ — adapt to the existing pattern in processTick.ts.

Add import:
```ts
import { applyPriceCheck } from "@domain/pipeline/applyPriceCheck";
```

- [ ] **Step 7: Run regression suites**

```sh
bun test test/workflows/setup test/workflows/replay
```
Expected: 0 regression. Existing tests don't exercise the new phase 0.5 — it activates only when a candle's range crosses invalidation, which the existing replay tests don't set up.

- [ ] **Step 8: Commit**

```bash
git add src/domain/pipeline/applyPriceCheck.ts \
        test/domain/pipeline/applyPriceCheck.test.ts \
        src/workflows/setup/setupWorkflow.ts \
        src/workflows/replay/processTick.ts
git commit -m "feat(pipeline): shared applyPriceCheck — replay invalidates pre-TRACKING

Drift D from the 2026-05-14 audit. Live's \`priceCheckSignal\` handler
invalidates REVIEWING/FINALIZING setups when the price crosses the
invalidation level. Replay had no equivalent — a setup whose price
moved through invalidation between detector ticks was never
invalidated in replay (only via TTL).

Extract the helper, use it in live, and add a phase 0.5 to replay's
\`processTick\` that scans alive setups against the candle's worst-case
intra-candle price (low for LONG, high for SHORT)."
```

---

## Task 6 — Wire `shouldSendReviewSignal` into replay (closes Drift I)

**Files:**
- Modify: `src/workflows/replay/processTick.ts` (phase 3 reviewer dispatch)

`shouldSendReviewSignal` already exists in `src/workflows/scheduler/reviewerGating.ts`. The replay path currently ignores it (runs the reviewer on every alive setup unconditionally). Wire it now that Task 4 has built `corroboratedIds`.

- [ ] **Step 1: Modify processTick.ts phase 3**

In `src/workflows/replay/processTick.ts`, find phase 3 (reviewer dispatch). Currently it iterates over alive REVIEWING setups and calls `runReviewerReplay` for each. Wrap the call with `shouldSendReviewSignal` :

```ts
// `corroboratedIds` was built in phase 2a (Task 4).
const reviewerSkipOnCorroborate =
  watch.optimization.reviewer_skip_when_detector_corroborated;

for (const [setupId, setup] of alive) {
  if (setup.runtime.status !== "REVIEWING") continue;
  if (
    !shouldSendReviewSignal({
      setupId,
      corroboratedIds,
      reviewerSkipOnCorroborate,
    })
  ) {
    continue; // skip — detector already corroborated this tick + flag set
  }
  // ... existing runReviewerReplay call ...
}
```

Add import:
```ts
import { shouldSendReviewSignal } from "@workflows/scheduler/reviewerGating";
```

Note: importing a helper from another workflow domain is intentional — `reviewerGating` lives in `scheduler/` because that's where it's used in live, but it's a pure function (no Temporal imports) so it's safe to reuse from replay. A future refactor could move it under `src/domain/pipeline/reviewerGating.ts` if shared usage grows.

- [ ] **Step 2: Run regression**

```sh
bun test test/workflows/replay
```
Expected: 0 regression. Existing replay tests stub `corroborations: []`, so `corroboratedIds` is empty and every setup gets a review — same as before.

- [ ] **Step 3: Commit**

```bash
git add src/workflows/replay/processTick.ts
git commit -m "feat(pipeline): replay honors reviewer_skip_when_detector_corroborated

Drift I from the 2026-05-14 audit. Live's schedulerWorkflow filters
review signals via \`shouldSendReviewSignal\` (per-watch flag, default
false). Replay's processTick ran the reviewer on every alive setup
unconditionally. Now that Task 4 wired corroborations into replay, we
have a populated \`corroboratedIds\` and can reuse the same gating
helper."
```

---

## Task 7 — Pipeline barrel + ergonomics

**Files:**
- Create: `src/domain/pipeline/index.ts`

- [ ] **Step 1: Create barrel**

`src/domain/pipeline/index.ts`:

```ts
export { applyCorroboration } from "./applyCorroboration";
export type {
  CorroborationInput,
  CorroborationResult,
  ScoringConfig,
  SetupRuntimeState,
} from "./applyCorroboration";

export { applyPriceCheck } from "./applyPriceCheck";
export type { PriceCheckInput, PriceCheckResult } from "./applyPriceCheck";

export { buildPriceInvalidationEvent } from "./priceInvalidationEvent";
export type {
  PriceInvalidationEvent,
  PriceInvalidationEventInput,
} from "./priceInvalidationEvent";

export { computeTtlExpiresAt } from "./computeTtlExpiresAt";
export type { ComputeTtlInput } from "./computeTtlExpiresAt";

export { shouldRunFeedback } from "./shouldRunFeedback";
export type { ShouldRunFeedbackInput } from "./shouldRunFeedback";

export { timeframeToMinutes, timeframeToMs } from "./timeframeToMs";
```

- [ ] **Step 2: Commit**

```bash
git add src/domain/pipeline/index.ts
git commit -m "chore(pipeline): barrel re-export"
```

---

## Task 8 — Parity harness types + comparator

**Files:**
- Create: `test/parity/types.ts`
- Create: `test/parity/compareEvents.ts`
- Create: `test/parity/expectEventChain.ts`

- [ ] **Step 1: Write types**

`test/parity/types.ts`:

```ts
import type { EventTypeName } from "@domain/events/types";
import type { DetectorOutput } from "@domain/schemas/DetectorOutput";
import type { Verdict } from "@domain/schemas/Verdict";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";

export type FinalizerDecision = {
  go: boolean;
  reasoning: string;
  entry?: number;
  stop_loss?: number;
  take_profit?: number[];
};

export type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: string;
};

export type PriceTick = {
  price: number;
  observedAt: string;
};

export type CapturedEvent = {
  setupId: string;
  type: EventTypeName;
  stage: string;
  actor: string;
  scoreDelta: number;
  scoreAfter: number;
  statusBefore?: SetupStatus;
  statusAfter?: SetupStatus;
  payloadType: string;
  payloadSource?: string;
  occurredAt: string;
};

export type ExpectedEvent = {
  type: EventTypeName;
  statusBefore?: SetupStatus;
  statusAfter?: SetupStatus;
  /** -1 = negative, 0 = zero, 1 = positive. Omitted = don't check. */
  scoreDeltaSign?: -1 | 0 | 1;
  /** Match `payload.data.source` if present. Omitted = don't check. */
  source?: "reviewer_full" | "detector_corroboration" | "detector_decorroboration";
};

export type PipelineScenario = {
  name: string;
  description: string;
  watch: WatchConfig;
  setup: {
    setupId: string;
    direction: "LONG" | "SHORT";
    initialScore: number;
    invalidationLevel: number;
    patternHint: string;
    patternCategory: "event" | "accumulation";
    expectedMaturationTicks: number;
  };
  ticks: Array<{
    tickAt: string;
    detectorVerdict: DetectorOutput;
    reviewerVerdict?: Verdict;
    finalizerDecision?: FinalizerDecision;
    candle: Candle;
    intraCandlePrices?: PriceTick[];
  }>;
  expectedEventChain: ExpectedEvent[];
};
```

- [ ] **Step 2: Write comparator**

`test/parity/compareEvents.ts`:

```ts
import type { EventTypeName } from "@domain/events/types";
import type { CapturedEvent } from "./types";

/**
 * Replay-only event types. Filtered out before parity comparison —
 * these have no live counterpart by design.
 */
const REPLAY_ONLY_TYPES: ReadonlySet<EventTypeName> = new Set([
  "DetectorTickProcessed",
  "ReplayMeta",
  "FeedbackLessonProposed",
]);

/**
 * Live-only event types. Filtered out before parity comparison.
 * `Killed` has no replay equivalent (no kill button in replay UI).
 */
const LIVE_ONLY_TYPES: ReadonlySet<EventTypeName> = new Set([
  "Killed",
]);

export type Drift = {
  index: number;
  field: "length" | "type" | "statusBefore" | "statusAfter" | "scoreDeltaSign" | "payloadSource";
  live: unknown;
  replay: unknown;
  message: string;
};

function sign(n: number): -1 | 0 | 1 {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

export function compareCanonical(live: CapturedEvent[], replay: CapturedEvent[]): Drift[] {
  const liveCanonical = live.filter((e) => !LIVE_ONLY_TYPES.has(e.type));
  const replayCanonical = replay.filter((e) => !REPLAY_ONLY_TYPES.has(e.type));
  const drifts: Drift[] = [];

  if (liveCanonical.length !== replayCanonical.length) {
    drifts.push({
      index: -1,
      field: "length",
      live: liveCanonical.length,
      replay: replayCanonical.length,
      message: `live emitted ${liveCanonical.length} canonical events, replay emitted ${replayCanonical.length}`,
    });
    return drifts; // can't compare per-index if lengths differ
  }

  for (let i = 0; i < liveCanonical.length; i++) {
    const l = liveCanonical[i];
    const r = replayCanonical[i];
    if (!l || !r) continue;

    if (l.type !== r.type) {
      drifts.push({ index: i, field: "type", live: l.type, replay: r.type, message: `event #${i} type mismatch` });
    }
    if (l.statusBefore !== r.statusBefore) {
      drifts.push({ index: i, field: "statusBefore", live: l.statusBefore, replay: r.statusBefore, message: `event #${i} statusBefore mismatch` });
    }
    if (l.statusAfter !== r.statusAfter) {
      drifts.push({ index: i, field: "statusAfter", live: l.statusAfter, replay: r.statusAfter, message: `event #${i} statusAfter mismatch` });
    }
    if (sign(l.scoreDelta) !== sign(r.scoreDelta)) {
      drifts.push({
        index: i,
        field: "scoreDeltaSign",
        live: sign(l.scoreDelta),
        replay: sign(r.scoreDelta),
        message: `event #${i} scoreDelta sign mismatch (live=${l.scoreDelta}, replay=${r.scoreDelta})`,
      });
    }
    if (l.payloadSource !== r.payloadSource) {
      drifts.push({ index: i, field: "payloadSource", live: l.payloadSource, replay: r.payloadSource, message: `event #${i} payload source mismatch` });
    }
  }

  return drifts;
}
```

- [ ] **Step 3: Write `expectEventChain`**

`test/parity/expectEventChain.ts`:

```ts
import { expect } from "bun:test";
import type { CapturedEvent, ExpectedEvent } from "./types";

function sign(n: number): -1 | 0 | 1 {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

/**
 * Asserts that `actual` events match `expected` in order, allowing
 * `expected` to be a subset (the canonical "interesting" events). Extra
 * events in `actual` between expected ones are ignored — useful when
 * replay emits replay-only events that we don't care about for parity.
 */
export function expectEventChain(actual: CapturedEvent[], expected: ExpectedEvent[]): void {
  let i = 0;
  for (const exp of expected) {
    let found = false;
    while (i < actual.length) {
      const a = actual[i];
      i++;
      if (!a || a.type !== exp.type) continue;
      if (exp.statusBefore !== undefined && a.statusBefore !== exp.statusBefore) continue;
      if (exp.statusAfter !== undefined && a.statusAfter !== exp.statusAfter) continue;
      if (exp.scoreDeltaSign !== undefined && sign(a.scoreDelta) !== exp.scoreDeltaSign) continue;
      if (exp.source !== undefined && a.payloadSource !== exp.source) continue;
      found = true;
      break;
    }
    expect(found, `expected ${JSON.stringify(exp)} in event chain but not found`).toBe(true);
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add test/parity/types.ts test/parity/compareEvents.ts test/parity/expectEventChain.ts
git commit -m "test(parity): types + comparator + expectEventChain helper"
```

---

## Task 9 — Parity harness runners

**Files:**
- Create: `test/parity/runners/runLive.ts`
- Create: `test/parity/runners/runReplay.ts`

The runners are the trickiest part. They produce `CapturedEvent[]` from running a `PipelineScenario` through the corresponding pipeline.

- [ ] **Step 1: Live runner stub (deferred concrete impl until first scenario)**

`test/parity/runners/runLive.ts`:

```ts
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import type { CapturedEvent, PipelineScenario } from "../types";

/**
 * Run a scenario against the live pipeline.
 *
 * Strategy: spin up a TestWorkflowEnvironment with fake activities :
 *   - runDetector → returns scenario.ticks[i].detectorVerdict
 *   - runReviewer → returns scenario.ticks[i].reviewerVerdict (if defined)
 *   - runFinalizer → returns scenario.ticks[i].finalizerDecision (if defined)
 *   - persistEvent → captures into `events: CapturedEvent[]`
 *   - listAliveSetups, dedupNewSetups, etc. → minimal stubs
 *
 * Start the schedulerWorkflow + setupWorkflow per scenario.setup, then
 * signal doTick per tick. After draining, return the captured events.
 *
 * Implemented incrementally as scenarios need it — see scenario tests
 * for the concrete fake activity definitions.
 */
export async function runLive(
  scenario: PipelineScenario,
  env: TestWorkflowEnvironment,
): Promise<CapturedEvent[]> {
  // First scenario (Task 10) drives the concrete impl. This stub raises
  // a clear error if invoked before then.
  throw new Error(
    `runLive not yet implemented — first scenario in Task 10 drives the build-out. ` +
    `Scenario: ${scenario.name}`,
  );
}
```

- [ ] **Step 2: Replay runner stub**

`test/parity/runners/runReplay.ts`:

```ts
import type { CapturedEvent, PipelineScenario } from "../types";

/**
 * Run a scenario against the replay pipeline.
 *
 * Strategy: build an in-memory ReplayActivityDeps with stubbed activities :
 *   - runDetectorReplay → returns scenario.ticks[i].detectorVerdict
 *   - runReviewerReplay → returns scenario.ticks[i].reviewerVerdict
 *   - runFinalizerReplay → returns scenario.ticks[i].finalizerDecision
 *   - fetchRangeCandles → returns [scenario.ticks[i].candle]
 *   - appendReplayEvent → captures into `events: CapturedEvent[]`
 *
 * Call `processTick()` directly per tick. Return captured events.
 */
export async function runReplay(scenario: PipelineScenario): Promise<CapturedEvent[]> {
  throw new Error(
    `runReplay not yet implemented — first scenario in Task 10 drives the build-out. ` +
    `Scenario: ${scenario.name}`,
  );
}
```

- [ ] **Step 3: Commit stubs**

```bash
git add test/parity/runners/
git commit -m "test(parity): stubs for runLive + runReplay (concrete impl in Task 10)"
```

---

## Task 10 — First parity scenario : corroboration positive (drives runners)

**Files:**
- Create: `test/parity/scenarios/corroboration-positive.scenario.ts`
- Create: `test/parity/scenarios/corroboration-positive.test.ts`
- Modify: `test/parity/runners/runLive.ts` (concrete impl)
- Modify: `test/parity/runners/runReplay.ts` (concrete impl)

This task is the largest — it builds out the concrete runner implementations through TDD on the first scenario. Subsequent scenarios (Tasks 11-12) just add new scenario files.

- [ ] **Step 1: Define the scenario fixture**

`test/parity/scenarios/corroboration-positive.scenario.ts`:

```ts
import type { PipelineScenario } from "../types";

const watchStub = {
  /* fill in minimal watch config — see existing fakes for shape */
} as PipelineScenario["watch"];

export const corroborationPositiveScenario: PipelineScenario = {
  name: "corroboration-positive",
  description:
    "Detector strengthens an alive setup 4 times (+8 each), crossing the 80 threshold → FINALIZING → finalizer GO → TRACKING → TPs hit",
  watch: watchStub,
  setup: {
    setupId: "test-setup-corrob-positive",
    direction: "LONG",
    initialScore: 50,
    invalidationLevel: 50_000,
    patternHint: "bull_flag",
    patternCategory: "accumulation",
    expectedMaturationTicks: 3,
  },
  ticks: [
    {
      tickAt: "2026-05-14T10:00:00.000Z",
      detectorVerdict: {
        corroborations: [{ setup_id: "test-setup-corrob-positive", evidence: ["higher_low"], confidence_delta_suggested: 8 }],
        new_setups: [],
        ignore_reason: null,
      },
      candle: { open: 51_000, high: 51_200, low: 50_900, close: 51_100, timestamp: "2026-05-14T10:00:00.000Z" },
    },
    {
      tickAt: "2026-05-14T10:15:00.000Z",
      detectorVerdict: {
        corroborations: [{ setup_id: "test-setup-corrob-positive", evidence: ["volume_spike"], confidence_delta_suggested: 8 }],
        new_setups: [],
        ignore_reason: null,
      },
      candle: { open: 51_100, high: 51_400, low: 51_000, close: 51_300, timestamp: "2026-05-14T10:15:00.000Z" },
    },
    {
      tickAt: "2026-05-14T10:30:00.000Z",
      detectorVerdict: {
        corroborations: [{ setup_id: "test-setup-corrob-positive", evidence: ["ema_cross"], confidence_delta_suggested: 8 }],
        new_setups: [],
        ignore_reason: null,
      },
      candle: { open: 51_300, high: 51_600, low: 51_200, close: 51_500, timestamp: "2026-05-14T10:30:00.000Z" },
    },
    {
      tickAt: "2026-05-14T10:45:00.000Z",
      detectorVerdict: {
        corroborations: [{ setup_id: "test-setup-corrob-positive", evidence: ["macd_bull"], confidence_delta_suggested: 8 }],
        new_setups: [],
        ignore_reason: null,
      },
      finalizerDecision: {
        go: true,
        reasoning: "Strong confluence",
        entry: 51_500,
        stop_loss: 50_500,
        take_profit: [52_500, 53_500],
      },
      candle: { open: 51_500, high: 53_800, low: 51_400, close: 53_700, timestamp: "2026-05-14T10:45:00.000Z" },
    },
  ],
  expectedEventChain: [
    { type: "Strengthened", source: "detector_corroboration", scoreDeltaSign: 1 },
    { type: "Strengthened", source: "detector_corroboration", scoreDeltaSign: 1 },
    { type: "Strengthened", source: "detector_corroboration", scoreDeltaSign: 1, statusAfter: "FINALIZING" },
    { type: "Confirmed", statusAfter: "TRACKING" },
    { type: "EntryFilled" },
    { type: "TPHit" },
    { type: "TPHit" },
  ],
};
```

Fill in `watchStub` with the minimal valid `WatchConfig` — copy from `test/workflows/setup/setupWorkflow.test.ts`'s `baseInitial` or `test/workflows/replay/_replayTestHelpers.ts` shape.

- [ ] **Step 2: Write the parity test (initially failing because runners are stubs)**

`test/parity/scenarios/corroboration-positive.test.ts`:

```ts
import { afterAll, beforeAll, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { compareCanonical } from "../compareEvents";
import { expectEventChain } from "../expectEventChain";
import { runLive } from "../runners/runLive";
import { runReplay } from "../runners/runReplay";
import { corroborationPositiveScenario } from "./corroboration-positive.scenario";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

test("parity: corroboration positive — score climbs, FINALIZING, GO, TPs hit", async () => {
  const liveEvents = await runLive(corroborationPositiveScenario, env);
  const replayEvents = await runReplay(corroborationPositiveScenario);

  const drifts = compareCanonical(liveEvents, replayEvents);
  if (drifts.length > 0) {
    throw new Error(`drifts found: ${JSON.stringify(drifts, null, 2)}`);
  }

  expectEventChain(liveEvents, corroborationPositiveScenario.expectedEventChain);
  expectEventChain(replayEvents, corroborationPositiveScenario.expectedEventChain);
}, 60_000);
```

- [ ] **Step 3: Run test, expect FAIL (stubs throw)**

```sh
bun test test/parity/scenarios/corroboration-positive.test.ts
```
Expected: fail with "runLive not yet implemented".

- [ ] **Step 4: Implement `runLive`**

Concrete `test/parity/runners/runLive.ts` implementation — see `test/workflows/setup/setupWorkflow.test.ts` for the activity-stub + worker-create pattern. Capture every `persistEvent` call into the `CapturedEvent[]` array (transform from the `event` shape into `CapturedEvent`). Run the setup workflow with `initial` derived from `scenario.setup`, signal `corroborate` / `review` / `priceCheck` according to the tick definitions, wait for terminal status, return events.

(Full implementation — ~150 LOC — derived from `test/workflows/setup/setupWorkflow.test.ts` patterns. The exact code is too long for inline ; cross-reference `_setupTestHelpers.ts`.)

- [ ] **Step 5: Implement `runReplay`**

Concrete `test/parity/runners/runReplay.ts` — see `test/workflows/replay/processTick.test.ts` for the in-memory deps pattern. Stub `runDetectorReplay`, `runReviewerReplay`, `runFinalizerReplay`, `fetchRangeCandles` from `scenario.ticks`. Call `processTick(deps, args)` once per tick. Capture events via the fake `appendReplayEvent` adapter.

- [ ] **Step 6: Run test, expect PASS**

```sh
bun test test/parity/scenarios/corroboration-positive.test.ts
```
Expected: 1 pass.

- [ ] **Step 7: Commit**

```bash
git add test/parity/scenarios/corroboration-positive.scenario.ts \
        test/parity/scenarios/corroboration-positive.test.ts \
        test/parity/runners/runLive.ts \
        test/parity/runners/runReplay.ts
git commit -m "test(parity): first scenario — corroboration positive

Drives the build-out of runLive (TestWorkflowEnvironment + fake
activities + persistEvent capture) and runReplay (in-memory deps +
processTick direct call + appendReplayEvent capture). Subsequent
scenarios just add fixture files."
```

---

## Task 11 — Parity scenarios : negative, mixed, reviewer-invalidate

**Files:**
- Create: `test/parity/scenarios/corroboration-negative.{scenario,test}.ts`
- Create: `test/parity/scenarios/mixed-corroborate-review.{scenario,test}.ts`
- Create: `test/parity/scenarios/reviewer-invalidate.{scenario,test}.ts`

Each test follows the Task 10 pattern : define scenario → write test that calls runners + comparator + expectEventChain → run, expect pass.

- [ ] **Step 1: corroboration-negative scenario**

Fixture : same shape as Task 10 but ticks emit corroborations with `confidence_delta_suggested: -8` until the score crosses scoreThresholdDead. Expected chain : 3-4 `Weakened` events with `source: detector_decorroboration`, last one with `statusAfter: "EXPIRED"`.

- [ ] **Step 2: Run + pass + commit**

```sh
bun test test/parity/scenarios/corroboration-negative.test.ts
```
Then commit.

- [ ] **Step 3: mixed-corroborate-review scenario**

Two alive setups : setup A is corroborated this tick (+5), setup B is NOT corroborated → reviewer fires on B only (with `reviewer_skip_when_detector_corroborated: true` in watch config). Expected chain : `Strengthened` event on A, `Strengthened` (or whatever the reviewer verdict is) on B with `source: reviewer_full`.

- [ ] **Step 4: Run + pass + commit**

- [ ] **Step 5: reviewer-invalidate scenario**

Reviewer emits `INVALIDATE` verdict. Expected chain : `Invalidated` event with `statusAfter: "INVALIDATED"`.

- [ ] **Step 6: Run + pass + commit**

---

## Task 12 — Parity scenarios : price-breach, sl-after-tp1, ttl-15m, feedback-disabled

**Files:**
- Create: `test/parity/scenarios/price-breach-during-reviewing.{scenario,test}.ts`
- Create: `test/parity/scenarios/sl-hit-after-tp1.{scenario,test}.ts`
- Create: `test/parity/scenarios/ttl-expired-15m.{scenario,test}.ts`
- Create: `test/parity/scenarios/feedback-disabled.{scenario,test}.ts`

- [ ] **Step 1: price-breach-during-reviewing scenario**

Setup REVIEWING with `invalidationLevel: 50_000` LONG. Tick's candle has `low: 49_500`. Expected : `PriceInvalidated` event from phase 0.5 of replay + priceCheckSignal handler on live, both with `actor: "price_monitor"`.

- [ ] **Step 2: Run + pass + commit**

- [ ] **Step 3: sl-hit-after-tp1 scenario**

Setup CONFIRMED with entry=51_500, SL=50_500, TPs=[52_500, 53_500]. Tick 1 candle hits TP1 (high=52_600). Tick 2 candle hits trailed SL at 51_500 (low=51_400). Expected : `EntryFilled`, `TPHit` (index=0), `TrailingMoved` (SL → entry), `SLHit`.

- [ ] **Step 4: Run + pass + commit**

- [ ] **Step 5: ttl-expired-15m scenario**

This scenario is special — it's a unit-level assertion that `computeTtlExpiresAt` returns the same value when called from live's `runOneTick` and replay's `processTick` for `ttl_candles: 50, primary: "15m"`. May not need full runners — just assert via the helper directly. (Edit the scenario format to accommodate or write as a normal test outside `/parity/`.)

Actually : skip the parity-runner approach here. Just verify the helper's output matches what's emitted in events. Replace this scenario with a small unit test that documents the regression :

```ts
test("ttl: 15m × 50 candles produces consistent ttlExpiresAt", () => {
  const from = new Date("2026-05-14T10:00:00.000Z");
  const ttl = computeTtlExpiresAt({
    fromTickAt: from,
    ttlCandles: 50,
    primaryTimeframe: "15m",
  });
  expect(ttl.toISOString()).toBe("2026-05-14T22:30:00.000Z");
  // NOT 50h (pre-fix live bug).
  expect(ttl.toISOString()).not.toBe("2026-05-16T12:00:00.000Z");
});
```

This is already covered by Task 1's tests, so this scenario can be reduced to a doc comment in the spec or skipped entirely.

- [ ] **Step 6: Skip ttl scenario (already covered by unit tests)**

- [ ] **Step 7: feedback-disabled scenario**

Watch with `feedback.enabled: false`. Setup goes through full lifecycle to SL hit. Expected : no `FeedbackLessonProposed` events in either replay or live (live doesn't start the child workflow at all ; replay's `runFeedbackAnalysisReplay` returns `skipped: true`).

- [ ] **Step 8: Run + pass + commit**

---

## Task 13 — `package.json` script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the script**

Add to the `scripts` section of `package.json` :

```json
"test:parity": "bun test test/parity",
```

After `"test:domain": "..."`.

- [ ] **Step 2: Run it to verify it works**

```sh
bun run test:parity
```
Expected : N tests pass (where N matches the scenarios written so far).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add test:parity script"
```

---

## Task 14 — Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Add Pipeline coherence section to CLAUDE.md**

In `CLAUDE.md`, add a new section after "The 'extract → unit-test → consume in workflow' pattern" :

```markdown
## Pipeline coherence (live ↔ replay)

The live pipeline (`setupWorkflow.ts` + `schedulerWorkflow.ts`) and the
replay pipeline (`processTick.ts`) MUST stay logically equivalent on the
same input. Strategy 3 (controlled duplication, see
`docs/superpowers/specs/2026-05-08-replay-mode-design.md`) means we
explicitly accept some duplication in exchange for clear isolation, but
**decisions that drive scoring or state transitions must be shared
helpers**, not duplicated logic.

The shared decisions live in `src/domain/pipeline/`:

- `applyCorroboration` — detector signed corroboration → Strengthened /
  Weakened event with the correct source discriminant.
- `applyPriceCheck` — REVIEWING/FINALIZING price breach → PriceInvalidated.
- `buildPriceInvalidationEvent` — canonical event builder used in both
  REVIEWING (price_monitor) and TRACKING (tracker) breach branches.
- `computeTtlExpiresAt` — `fromTickAt + ttl_candles × timeframe`. Used by
  live's scheduler workflow AND replay's processTick.
- `shouldRunFeedback` — combined watch flag + session mode + outcome
  eligibility for the feedback loop.
- `timeframeToMinutes` / `timeframeToMs` — single source of truth for
  candle duration math.

When adding a new pipeline feature: if it makes a scoring or state
decision, extract it into `src/domain/pipeline/` first and consume from
both pipelines. The cross-pipeline harness (`test/parity/`) will catch
drift if you forget — but extract proactively.

See `docs/superpowers/specs/2026-05-14-pipeline-coherence-design.md`.
```

- [ ] **Step 2: Add test:parity row to README.md test table**

In `README.md`, find the Tests table. Add a row :

```markdown
| Parity | `bun run test:parity` | 30-90s | TestWorkflowEnvironment (downloads Temporal CLI) | Cross-pipeline regression: same scenarios run on live + replay, events compared |
```

After the "Workflows" row.

Also add a mention in the Replay Mode section: "Le replay est harnessé pour parity event-à-event vs live (`test:parity` — 8 scénarios canoniques)."

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: pipeline coherence section + test:parity reference"
```

---

## Task 15 — Final verification

- [ ] **Step 1: Run full test suite**

```sh
bun test test/domain test/adapters test/workflows test/client test/parity
```
Expected : ~1000+ tests pass, 0 regressions, only the pre-existing 5 replay-integration webpack-issue failures remain.

- [ ] **Step 2: Type-check**

```sh
bunx tsc --noEmit
```
Expected : 0 errors.

- [ ] **Step 3: Lint**

```sh
bunx @biomejs/biome check src/domain/pipeline test/domain/pipeline test/parity \
  src/workflows/setup/setupWorkflow.ts src/workflows/scheduler/schedulerWorkflow.ts \
  src/workflows/replay/processTick.ts src/workflows/setup/trackingLoop.ts \
  src/workflows/replay/activities.ts
```
Expected : clean.

- [ ] **Step 4: Rebuild workers + verify health**

```sh
docker compose -f docker-compose.yml -f docker-compose-dev.yaml up -d --build analysis-worker scheduler-worker
sleep 10
docker logs --tail 5 tf-analysis-worker | grep "state changed"
docker logs --tail 5 tf-scheduler-worker | grep "state changed"
```
Expected : both workers RUNNING.

- [ ] **Step 5: Final commit / merge to main**

```sh
git checkout main
git merge --ff-only <branch-name>
git log --oneline -15
```

---

## Success criteria (from spec)

1. ✅ 6 helpers exist in `src/domain/pipeline/` with passing unit tests (Tasks 1-5, 7)
2. ✅ Live + replay consume the same helpers — no duplicated decision logic
3. ✅ `test:parity` harness exists with 6+ scenarios all green
4. ✅ TTL live bug fixed (Task 1, asserted in unit tests)
5. ✅ Replay produces `PriceInvalidated` event for tracker-time invalidations (Task 2)
6. ✅ Drift A resolved: detector corroboration flows through replay (Task 4 + parity scenario in Task 10)
7. ✅ Spec committed (already done, `f7ea6d6`)
