import { afterAll, beforeAll, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { compareCanonical } from "../compareEvents";
import { expectEventChain } from "../expectEventChain";
import { runLive } from "../runners/runLive";
import { runReplay } from "../runners/runReplay";
import { corroborationPositiveScenario } from "./corroboration-positive.scenario";

/**
 * First cross-pipeline parity test.
 *
 * Runs the `corroboration-positive` scenario through BOTH pipelines and
 * asserts :
 *  - `compareCanonical(live, replay)` finds zero drift on canonical
 *    events (after filtering pipeline-specific event types like
 *    `Killed` / `DetectorTickProcessed` / `ReplayMeta`).
 *  - Both event chains contain the scenario's `expectedEventChain`
 *    landmarks in chronological order.
 *
 * The first scenario in this harness ; if it fails on wiring (length
 * mismatch, missing helper), the comparator dumps a structured drift
 * report. If it fails on a REAL canonical drift (mismatched
 * `payloadSource`, mismatched `statusAfter`), that's a regression worth
 * investigating — do not silently widen the comparator's filter sets.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

test("parity: corroboration-positive → score climbs, FINALIZING, GO", async () => {
  const replayEvents = await runReplay(corroborationPositiveScenario);
  const liveEvents = await runLive(corroborationPositiveScenario, env);

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

  expectEventChain(replayEvents, corroborationPositiveScenario.expectedEventChain);
  expectEventChain(liveEvents, corroborationPositiveScenario.expectedEventChain);
}, 120_000);
