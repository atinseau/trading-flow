import { describe, expect, test } from "bun:test";
import { computeStepGating } from "@client/components/replay/replayStepGating";

/**
 * Truth-table tests for the replay-controls gating logic. The component
 * currently has 4 axes (status × stepInFlight × workflowBusy × pendingTicks)
 * compressed into 4 boolean outputs ; exhaustive coverage catches any
 * future re-introduction of the original bug (Step button clickable while
 * the workflow is still chewing on the previous tick, hiding the truth from
 * the user).
 */

const READY_IDLE = {
  status: "READY" as const,
  stepInFlight: false,
  workflowBusy: false,
  pendingTicks: 0,
};

describe("computeStepGating — happy paths", () => {
  test("READY + no work in flight → everything enabled, no badge", () => {
    const g = computeStepGating(READY_IDLE);
    expect(g.stepDisabled).toBe(false);
    expect(g.autoDisabled).toBe(false);
    expect(g.showBusyBadge).toBe(false);
    expect(g.workflowActivelyProcessing).toBe(false);
  });

  test("PAUSED idle → step enabled (resume gates Auto)", () => {
    const g = computeStepGating({ ...READY_IDLE, status: "PAUSED" });
    expect(g.stepDisabled).toBe(false);
    // Auto only operates from READY — paused users must explicitly resume
    // before auto-stepping, otherwise the loop would silently no-op against
    // a workflow that won't process its queue.
    expect(g.autoDisabled).toBe(true);
    expect(g.showBusyBadge).toBe(false);
  });
});

describe("computeStepGating — terminal states", () => {
  test("COMPLETED disables everything", () => {
    const g = computeStepGating({ ...READY_IDLE, status: "COMPLETED" });
    expect(g.stepDisabled).toBe(true);
    expect(g.autoDisabled).toBe(true);
  });

  test("FAILED disables everything", () => {
    const g = computeStepGating({ ...READY_IDLE, status: "FAILED" });
    expect(g.stepDisabled).toBe(true);
    expect(g.autoDisabled).toBe(true);
  });

  test("COST_CAPPED disables everything (user must raise cap)", () => {
    const g = computeStepGating({ ...READY_IDLE, status: "COST_CAPPED" });
    expect(g.stepDisabled).toBe(true);
    expect(g.autoDisabled).toBe(true);
  });
});

describe("computeStepGating — busy gating (the regression we're protecting)", () => {
  test("stepInFlight (HTTP roundtrip in flight) disables step", () => {
    const g = computeStepGating({ ...READY_IDLE, stepInFlight: true });
    expect(g.stepDisabled).toBe(true);
    // Auto can keep going as long as the workflow isn't stuck — the next
    // iteration of the loop will gate on stepInFlight separately.
    expect(g.autoDisabled).toBe(false);
  });

  test("workflowBusy (tick processing) disables step AND auto AND shows badge", () => {
    // This is the exact case the user reported : clicking Step appeared
    // successful (200 OK) but nothing happened on screen because the
    // workflow was still running Detector → Reviewer → Finalizer on the
    // previous tick. The gate must respect the live workflow state.
    const g = computeStepGating({ ...READY_IDLE, workflowBusy: true });
    expect(g.stepDisabled).toBe(true);
    expect(g.autoDisabled).toBe(true);
    expect(g.showBusyBadge).toBe(true);
    expect(g.workflowActivelyProcessing).toBe(true);
  });

  test("pendingTicks > 0 alone (queued but not yet running) still disables", () => {
    // Realistic case : Step 5 batches 5 ticks ; the first is processing,
    // the other 4 are queued. The user shouldn't be able to fire-and-forget
    // more on top.
    const g = computeStepGating({ ...READY_IDLE, pendingTicks: 4 });
    expect(g.stepDisabled).toBe(true);
    expect(g.autoDisabled).toBe(true);
    expect(g.showBusyBadge).toBe(true);
    // The badge text should differentiate "actively processing" from
    // "queued and waiting" so the user reads accurate progress.
    expect(g.workflowActivelyProcessing).toBe(false);
  });

  test("workflowBusy WINS over pendingTicks for the active-processing flag", () => {
    // Both true — the workflow is processing AND has more queued. The
    // "Raisonnement en cours…" message is more useful than "N tick(s) en
    // file" because it tells the user something is actually happening now.
    const g = computeStepGating({
      ...READY_IDLE,
      workflowBusy: true,
      pendingTicks: 3,
    });
    expect(g.workflowActivelyProcessing).toBe(true);
    expect(g.showBusyBadge).toBe(true);
  });
});

describe("computeStepGating — interaction matrix spot-checks", () => {
  test("PAUSED + busy still disables everything (don't show false hope)", () => {
    const g = computeStepGating({
      status: "PAUSED",
      stepInFlight: false,
      workflowBusy: true,
      pendingTicks: 0,
    });
    expect(g.stepDisabled).toBe(true);
    expect(g.autoDisabled).toBe(true);
    expect(g.showBusyBadge).toBe(true);
  });

  test("READY + stepInFlight + workflowBusy collapses Step but keeps Auto enabled in steady state... wait, no — Auto must gate on busy too", () => {
    // Document the actual contract : even when only `stepInFlight` is
    // true (no workflow signal back yet), Auto remains enabled because
    // its own loop iteration WILL skip on stepInFlight. But when the
    // workflow is genuinely busy, Auto must wait.
    const g = computeStepGating({
      ...READY_IDLE,
      stepInFlight: true,
      workflowBusy: true,
    });
    expect(g.stepDisabled).toBe(true);
    expect(g.autoDisabled).toBe(true);
  });
});
