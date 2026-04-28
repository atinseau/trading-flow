import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { InvalidConfigError } from "@domain/errors";
import type { NewEvent, SetupStateUpdate } from "@domain/ports/EventStore";
import type { Verdict } from "@domain/schemas/Verdict";
import { VerdictSchema } from "@domain/schemas/Verdict";
import { computeInputHash } from "@domain/services/inputHash";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { z } from "zod";

const FinalizerOutputSchema = z.object({
  go: z.boolean(),
  reasoning: z.string(),
  entry: z.number().optional(),
  stop_loss: z.number().optional(),
  take_profit: z.array(z.number()).optional(),
});

export function buildSetupActivities(deps: ActivityDeps) {
  return {
    async persistEvent(input: { event: NewEvent; setupUpdate: SetupStateUpdate }) {
      return deps.eventStore.append(input.event, input.setupUpdate);
    },

    async nextSequence(input: { setupId: string }): Promise<{ sequence: number }> {
      return { sequence: await deps.eventStore.nextSequence(input.setupId) };
    },

    async runReviewer(input: {
      setupId: string;
      tickSnapshotId: string;
      watchId: string;
    }): Promise<{ verdictJson: string; costUsd: number; eventAlreadyExisted: boolean }> {
      const watch = deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      const setup = await deps.setupRepo.get(input.setupId);
      if (!setup) throw new Error(`Setup ${input.setupId} not found`);
      const snap = await deps.tickSnapshotStore.get(input.tickSnapshotId);
      if (!snap) throw new Error(`TickSnapshot ${input.tickSnapshotId} not found`);

      const ohlcvBuf = await deps.artifactStore.get(snap.ohlcvUri);
      const promptVersion = "reviewer_v1";
      const inputHash = computeInputHash({
        setupId: input.setupId,
        promptVersion,
        ohlcvSnapshot: ohlcvBuf.toString("hex").slice(0, 64),
        chartUri: snap.chartUri,
        indicators: snap.indicators as unknown as Record<string, number>,
      });

      const cached = await deps.eventStore.findByInputHash(input.setupId, inputHash);
      if (cached) {
        return {
          verdictJson: JSON.stringify(cached.payload.data),
          costUsd: 0,
          eventAlreadyExisted: true,
        };
      }

      const history = await deps.eventStore.listForSetup(input.setupId);
      const memoryBlock = history
        .map((e) => `[seq ${e.sequence}] ${e.type} score→${e.scoreAfter}`)
        .join("\n");
      const prompt = `Setup ${setup.asset} ${setup.timeframe} score=${setup.currentScore}\n\nHistory:\n${memoryBlock}\n\nFresh data + chart attached. Reply JSON Verdict.`;

      const result = await resolveAndCall(
        watch.analyzers.reviewer.provider,
        {
          systemPrompt: "You refine an existing setup.",
          userPrompt: prompt,
          images: [{ sourceUri: snap.chartUri, mimeType: "image/png" }],
          model: watch.analyzers.reviewer.model,
          maxTokens: watch.analyzers.reviewer.max_tokens,
          responseSchema: VerdictSchema,
        },
        deps.llmProviders,
      );
      const verdict = result.output.parsed as Verdict;
      return {
        verdictJson: JSON.stringify({
          verdict,
          inputHash,
          promptVersion,
          provider: result.usedProvider,
        }),
        costUsd: result.output.costUsd,
        eventAlreadyExisted: false,
      };
    },

    async runFinalizer(input: {
      setupId: string;
      watchId: string;
    }): Promise<{ decisionJson: string; costUsd: number }> {
      const watch = deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      const setup = await deps.setupRepo.get(input.setupId);
      if (!setup) throw new Error(`Setup ${input.setupId} not found`);
      const history = await deps.eventStore.listForSetup(input.setupId);

      const prompt = `Setup ${setup.asset} ${setup.timeframe} reached threshold (score ${setup.currentScore}).
Direction: ${setup.direction}
Invalidation: ${setup.invalidationLevel}
History sequence: ${history.length} events
Decision: GO or NO_GO? If GO, provide entry/SL/TP.`;

      const result = await resolveAndCall(
        watch.analyzers.finalizer.provider,
        {
          systemPrompt: "You make the final go/no-go call.",
          userPrompt: prompt,
          model: watch.analyzers.finalizer.model,
          maxTokens: watch.analyzers.finalizer.max_tokens,
          responseSchema: FinalizerOutputSchema,
        },
        deps.llmProviders,
      );

      return {
        decisionJson: JSON.stringify(result.output.parsed),
        costUsd: result.output.costUsd,
      };
    },

    async markSetupClosed(input: { setupId: string; finalStatus: string }) {
      await deps.setupRepo.markClosed(input.setupId, input.finalStatus as never);
    },

    async listEventsForSetup(input: { setupId: string }) {
      return deps.eventStore.listForSetup(input.setupId);
    },

    async loadSetup(input: { setupId: string }) {
      return deps.setupRepo.get(input.setupId);
    },
  };
}
