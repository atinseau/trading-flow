import { afterAll, beforeAll, expect, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { compareCanonical } from "../compareEvents";
import { expectEventChain } from "../expectEventChain";
import { runLive } from "../runners/runLive";
import { runReplay } from "../runners/runReplay";
import { feedbackDisabledScenario } from "./feedback-disabled.scenario";

/**
 * Feedback-disabled parity test.
 *
 * Asserts both pipelines invalidate via reviewer INVALIDATE (same as
 * reviewer-invalidate) AND that no `FeedbackLessonProposed` event is
 * emitted by either side.
 *
 * The absence-assertion (`hasFeedback === false`) is the value-add
 * over reviewer-invalidate : if a future change accidentally hooks
 * a feedback emission into the REVIEWING-INVALIDATE branch of either
 * pipeline, this test fails loudly.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

test("parity: feedback-disabled → INVALIDATED + no FeedbackLessonProposed", async () => {
  const replayEvents = await runReplay(feedbackDisabledScenario);
  const liveEvents = await runLive(feedbackDisabledScenario, env);

  // Absence test : no FeedbackLessonProposed on either side.
  const replayFeedback = replayEvents.some((e) => e.type === "FeedbackLessonProposed");
  const liveFeedback = liveEvents.some((e) => e.type === "FeedbackLessonProposed");
  expect(
    replayFeedback,
    "replay emitted FeedbackLessonProposed despite feedback.enabled=false",
  ).toBe(false);
  expect(liveFeedback, "live emitted FeedbackLessonProposed despite feedback.enabled=false").toBe(
    false,
  );

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

  expectEventChain(replayEvents, feedbackDisabledScenario.expectedEventChain);
  expectEventChain(liveEvents, feedbackDisabledScenario.expectedEventChain);
}, 120_000);
