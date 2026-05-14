import { afterAll, beforeAll, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { compareCanonical } from "../compareEvents";
import { expectEventChain } from "../expectEventChain";
import { runLive } from "../runners/runLive";
import { runReplay } from "../runners/runReplay";
import { corroborationNegativeScenario } from "./corroboration-negative.scenario";

/**
 * Negative-corroboration parity test : mirrors `corroboration-positive`
 * with a Δ=-8 trajectory that drives the score to the dead threshold
 * and EXPIRES the setup on the fourth tick.
 *
 * Exercises the `applyCorroboration` helper's `newScore <= dead` branch
 * across both pipelines. The replay pipeline runs `applyCorroboration`
 * in `processTick` phase 2 ; the live pipeline runs the same helper
 * inside `corroborateSignal`. Both must agree on the resulting
 * `Weakened` chain and the terminal `statusAfter = "EXPIRED"` flip.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

test("parity: corroboration-negative → score falls to dead threshold → EXPIRED", async () => {
  const replayEvents = await runReplay(corroborationNegativeScenario);
  const liveEvents = await runLive(corroborationNegativeScenario, env);

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

  expectEventChain(replayEvents, corroborationNegativeScenario.expectedEventChain);
  expectEventChain(liveEvents, corroborationNegativeScenario.expectedEventChain);
}, 120_000);
