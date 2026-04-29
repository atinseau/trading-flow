#!/usr/bin/env bun
/**
 * Re-run the feedback pipeline (gather → analyze → optionally apply) for a
 * single setup. Dry-run by default; pass `--apply` to persist results.
 *
 * `--providers=id1,id2,...` overrides the watch's enabled feedback context
 * providers (the watch's `feedback.context_providers_disabled` is replaced
 * with the complement of the supplied list).
 */
import { deriveCloseOutcome, shouldTriggerFeedback } from "@domain/feedback/closeOutcome";
import type { SetupStatus } from "@domain/state-machine/setupTransitions";
import { buildFeedbackActivities } from "@workflows/feedback/activities";
import {
  PROVIDER_CANONICAL_ORDER,
  type KnownProviderId,
} from "@adapters/feedback-context/FeedbackContextProviderRegistry";
import { wireFeedbackActivitiesForCli } from "./_feedback-adapters";

async function main() {
  const setupId = process.argv[2];
  if (!setupId) {
    console.error("usage: replay-feedback.ts <setup-id> [--apply] [--providers=id1,id2,...]");
    process.exit(2);
  }
  const apply = process.argv.includes("--apply");
  const provArg = process.argv.find((a) => a.startsWith("--providers="));
  const providersOverride =
    provArg
      ?.slice(12)
      .split(",")
      .filter((s) => s.length > 0) ?? null;

  const wiring = await wireFeedbackActivitiesForCli();
  try {
    const setup = await wiring.deps.setupRepo.get(setupId);
    if (!setup) {
      console.error(`Setup ${setupId} not found`);
      process.exit(1);
    }

    const events = await wiring.deps.eventStore.listForSetup(setupId);
    const everConfirmed = events.some((e) => e.type === "Confirmed");

    // Replay assumes the setup has reached a terminal state. Derive the
    // CloseOutcome from its final status; we cannot reconstruct the
    // trackingResult.reason from events alone, so for CLOSED/INVALIDATED
    // setups we default the close reason to a sensible value.
    const finalStatus = setup.status as SetupStatus;
    let trackingReason: "sl_hit_direct" | "sl_hit_after_tp1" | "all_tps_hit" | undefined;
    // Heuristic: if status is CLOSED, we use sl_hit_direct as default since
    // shouldTriggerFeedback only fires on sl_hit/price_invalidated. The
    // operator can manually rewrite if they need a different scenario.
    if (finalStatus === "CLOSED") trackingReason = "sl_hit_direct";

    const closeOutcome = deriveCloseOutcome({
      finalStatus,
      trackingResult: trackingReason ? { reason: trackingReason } : undefined,
      everConfirmed,
    });

    if (!shouldTriggerFeedback(closeOutcome)) {
      console.error(
        `Setup ${setupId} (status=${finalStatus}, everConfirmed=${everConfirmed}) is not feedback-eligible`,
      );
      console.error(`  closeOutcome: ${JSON.stringify(closeOutcome)}`);
      process.exit(1);
    }

    // Apply --providers override by patching the watch's disabled list.
    if (providersOverride) {
      const watch = wiring.deps.watchById(setup.watchId);
      if (!watch) {
        console.error(`Watch ${setup.watchId} not found in config`);
        process.exit(1);
      }
      const allowed = new Set<string>(providersOverride);
      const newDisabled: string[] = [];
      for (const p of PROVIDER_CANONICAL_ORDER) {
        if (!allowed.has(p)) newDisabled.push(p);
      }
      watch.feedback.context_providers_disabled = newDisabled as KnownProviderId[];
    }

    const activities = buildFeedbackActivities(wiring.deps);

    console.log(`Replaying feedback for setup ${setupId}`);
    console.log(`  watch:        ${setup.watchId}`);
    console.log(`  asset:        ${setup.asset}`);
    console.log(`  timeframe:    ${setup.timeframe}`);
    console.log(`  status:       ${setup.status}`);
    console.log(`  closeOutcome: ${JSON.stringify(closeOutcome)}`);
    console.log("");

    const ctx = await activities.gatherFeedbackContext({
      setupId,
      watchId: setup.watchId,
      closeOutcome,
    });
    console.log(`Context: ${ctx.chunkHashes.length} chunks (ref=${ctx.contextRef})`);

    const analysis = await activities.runFeedbackAnalysis({
      setupId,
      watchId: setup.watchId,
      contextRef: ctx.contextRef,
      chunkHashes: ctx.chunkHashes,
    });

    console.log("");
    console.log(
      `Analysis: provider=${analysis.provider} model=${analysis.model} cached=${analysis.cached} costUsd=${analysis.costUsd}`,
    );
    console.log("");
    console.log("Summary:");
    console.log(`  ${analysis.summary}`);
    console.log("");
    console.log(`Actions (${analysis.actions.length}):`);
    for (const action of analysis.actions) {
      console.log(JSON.stringify(action, null, 2));
    }

    if (analysis.cached) {
      console.log("");
      console.log("(cache hit — no new actions to apply)");
      return;
    }

    if (apply) {
      console.log("");
      console.log("Applying...");
      const result = await activities.applyLessonChanges({
        setupId,
        watchId: setup.watchId,
        closeReason: closeOutcome.reason,
        proposedActions: analysis.actions,
        feedbackPromptVersion: analysis.promptVersion,
        provider: analysis.provider,
        model: analysis.model,
        inputHash: analysis.inputHash,
        costUsd: analysis.costUsd,
        latencyMs: analysis.latencyMs,
      });
      console.log(
        `Applied: changes=${result.changesApplied} pending=${result.pendingApprovalsCreated} costUsd=${result.costUsd}`,
      );
    } else {
      console.log("");
      console.log("(dry-run; pass --apply to persist)");
    }
  } finally {
    await wiring.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
