import { afterAll, beforeAll, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { compareCanonical } from "../compareEvents";
import { expectEventChain } from "../expectEventChain";
import { runLive } from "../runners/runLive";
import { runReplay } from "../runners/runReplay";
import { priceBreachDuringReviewingScenario } from "./price-breach-during-reviewing.scenario";

/**
 * Price-breach-during-reviewing parity test.
 *
 * Both pipelines see a candle whose low (=49_500) breaches the setup's
 * invalidationLevel (=50_000) while the setup is still in REVIEWING.
 * Replay : phase 0.5 detects the breach against `candle.low`.
 * Live : the runner translates the scenario's `intraCandlePrices` into
 * `priceCheck` signals sent BEFORE the detector/reviewer signals on
 * the tick.
 *
 * Both must emit a single `PriceInvalidated` event with
 * `statusAfter = "INVALIDATED"`, built by the shared
 * `buildPriceInvalidationEvent` helper.
 */

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

test("parity: price-breach-during-reviewing → PriceInvalidated", async () => {
  const replayEvents = await runReplay(priceBreachDuringReviewingScenario);
  const liveEvents = await runLive(priceBreachDuringReviewingScenario, env);

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

  expectEventChain(replayEvents, priceBreachDuringReviewingScenario.expectedEventChain);
  expectEventChain(liveEvents, priceBreachDuringReviewingScenario.expectedEventChain);
}, 120_000);
