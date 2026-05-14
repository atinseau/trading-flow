import { afterAll, beforeAll, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { compareCanonical } from "../compareEvents";
import { expectEventChain } from "../expectEventChain";
import { runLive } from "../runners/runLive";
import { runReplay } from "../runners/runReplay";
import { reviewerInvalidateScenario } from "./reviewer-invalidate.scenario";

/**
 * Reviewer-invalidate parity test.
 *
 * One tick : detector empty, reviewer emits INVALIDATE → the setup
 * transitions REVIEWING → INVALIDATED with an `Invalidated` event in
 * both pipelines.
 *
 * This is the first scenario to exercise the per-tick reviewer-verdict
 * override in `runLive` (the `currentReviewTickIdx` closure). The
 * replay runner has supported this since T10 via `makeFakeProxies(...,
 * tickIdx, events)` — the per-tick fake is created fresh inside the
 * tick loop.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

test("parity: reviewer-invalidate → INVALIDATED", async () => {
  const replayEvents = await runReplay(reviewerInvalidateScenario);
  const liveEvents = await runLive(reviewerInvalidateScenario, env);

  const drifts = compareCanonical(liveEvents, replayEvents);
  if (drifts.length > 0) {
    const liveSummary = liveEvents.map(
      (e) =>
        `${e.type}[${e.payloadSource ?? "-"}|${e.statusBefore ?? "?"}→${e.statusAfter ?? "?"}|Δ${e.scoreDelta}]`,
    );
    const replaySummary = replayEvents.map(
      (e) =>
        `${e.type}[${e.payloadSource ?? "-"}|${e.statusBefore ?? "?"}→${e.statusAfter ?? "?"}|Δ${e.scoreDelta}]`,
    );
    throw new Error(
      `Cross-pipeline drift detected:\n` +
        `live:   ${liveSummary.join(", ")}\n` +
        `replay: ${replaySummary.join(", ")}\n` +
        `drifts: ${JSON.stringify(drifts, null, 2)}`,
    );
  }

  expectEventChain(replayEvents, reviewerInvalidateScenario.expectedEventChain);
  expectEventChain(liveEvents, reviewerInvalidateScenario.expectedEventChain);
}, 120_000);
