import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import { InvalidConfigError } from "@domain/errors";
import type { EventPayload } from "@domain/events/schemas";
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
    async createSetup(input: {
      setupId: string;
      watchId: string;
      asset: string;
      timeframe: string;
      patternHint: string;
      invalidationLevel: number;
      direction: "LONG" | "SHORT";
      ttlCandles: number;
      ttlExpiresAt: string;
      initialScore: number;
      workflowId: string;
    }) {
      return deps.setupRepo.create({
        id: input.setupId,
        watchId: input.watchId,
        asset: input.asset,
        timeframe: input.timeframe,
        status: "REVIEWING",
        currentScore: input.initialScore,
        patternHint: input.patternHint,
        invalidationLevel: input.invalidationLevel,
        direction: input.direction,
        ttlCandles: input.ttlCandles,
        ttlExpiresAt: new Date(input.ttlExpiresAt),
        workflowId: input.workflowId,
      });
    },

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
    }): Promise<{
      verdictJson: string;
      costUsd: number;
      eventAlreadyExisted: boolean;
      inputHash: string;
      promptVersion: string;
      provider: string;
      model: string;
    }> {
      const watch = deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      const setup = await deps.setupRepo.get(input.setupId);
      if (!setup) throw new Error(`Setup ${input.setupId} not found`);
      const snap = await deps.tickSnapshotStore.get(input.tickSnapshotId);
      if (!snap) throw new Error(`TickSnapshot ${input.tickSnapshotId} not found`);

      const ohlcvBuf = await deps.artifactStore.get(snap.ohlcvUri);
      const reviewerPrompt = await loadPrompt("reviewer");
      const promptVersion = reviewerPrompt.version;
      const inputHash = computeInputHash({
        setupId: input.setupId,
        promptVersion,
        ohlcvSnapshot: ohlcvBuf.toString("hex").slice(0, 64),
        chartUri: snap.chartUri,
        indicators: snap.indicators as unknown as Record<string, number>,
      });

      const cached = await deps.eventStore.findByInputHash(input.setupId, inputHash);
      if (cached) {
        // Idempotent retry — workflow will skip applyVerdict + persistEvent.
        return {
          verdictJson: "",
          costUsd: 0,
          eventAlreadyExisted: true,
          inputHash,
          promptVersion,
          provider: cached.provider ?? "",
          model: cached.model ?? "",
        };
      }

      const history = await deps.eventStore.listForSetup(input.setupId);
      const userPrompt = reviewerPrompt.render({
        setup: {
          id: setup.id,
          patternHint: setup.patternHint,
          direction: setup.direction,
          currentScore: setup.currentScore,
          invalidationLevel: setup.invalidationLevel,
          ageInCandles: 0,
        },
        history: history.map((e) => ({
          sequence: e.sequence,
          occurredAt: e.occurredAt.toISOString(),
          scoreAfter: e.scoreAfter,
          type: e.type,
          observations: extractObservations(e.payload),
          reasoning: extractReasoning(e.payload),
        })),
        tick: { tickAt: snap.tickAt.toISOString() },
        fresh: { lastClose: 0, indicators: snap.indicators },
      });

      const result = await resolveAndCall(
        watch.analyzers.reviewer.provider,
        {
          systemPrompt: "You refine an existing setup.",
          userPrompt,
          images: [{ sourceUri: snap.chartUri, mimeType: "image/png" }],
          model: watch.analyzers.reviewer.model,
          maxTokens: watch.analyzers.reviewer.max_tokens,
          responseSchema: VerdictSchema,
        },
        deps.llmProviders,
      );
      const verdict = result.output.parsed as Verdict;
      return {
        verdictJson: JSON.stringify(verdict),
        costUsd: result.output.costUsd,
        eventAlreadyExisted: false,
        inputHash,
        promptVersion,
        provider: result.usedProvider,
        model: watch.analyzers.reviewer.model,
      };
    },

    async runFinalizer(input: {
      setupId: string;
      watchId: string;
    }): Promise<{ decisionJson: string; costUsd: number; promptVersion: string }> {
      const watch = deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);
      const setup = await deps.setupRepo.get(input.setupId);
      if (!setup) throw new Error(`Setup ${input.setupId} not found`);
      const history = await deps.eventStore.listForSetup(input.setupId);

      const finalizerPrompt = await loadPrompt("finalizer");
      const userPrompt = finalizerPrompt.render({
        setup: {
          id: setup.id,
          asset: setup.asset,
          timeframe: setup.timeframe,
          patternHint: setup.patternHint,
          direction: setup.direction,
          currentScore: setup.currentScore,
          invalidationLevel: setup.invalidationLevel,
        },
        historyCount: history.length,
        history: history.map((e) => ({
          sequence: e.sequence,
          type: e.type,
          scoreAfter: e.scoreAfter,
        })),
      });

      const result = await resolveAndCall(
        watch.analyzers.finalizer.provider,
        {
          systemPrompt: "You make the final go/no-go call.",
          userPrompt,
          model: watch.analyzers.finalizer.model,
          maxTokens: watch.analyzers.finalizer.max_tokens,
          responseSchema: FinalizerOutputSchema,
        },
        deps.llmProviders,
      );

      return {
        decisionJson: JSON.stringify(result.output.parsed),
        costUsd: result.output.costUsd,
        promptVersion: finalizerPrompt.version,
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

    async notifyTelegramConfirmed(input: {
      watchId: string;
      asset: string;
      timeframe: string;
      direction: "LONG" | "SHORT";
      entry: number;
      stopLoss: number;
      takeProfit: number[];
      reasoning: string;
      chartUri?: string;
    }): Promise<{ messageId: number } | null> {
      const watch = deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notifications.notify_on.includes("confirmed")) return null;

      const arrow = input.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      const tpStr = input.takeProfit.length ? `\nTP: ${input.takeProfit.join(" / ")}` : "";
      const reasoning = watch.notifications.include_reasoning ? `\n\n${input.reasoning}` : "";
      const text = `${arrow} ${input.asset} ${input.timeframe}\nEntry: ${input.entry}\nSL: ${input.stopLoss}${tpStr}${reasoning}`;

      const images =
        watch.notifications.include_chart_image && input.chartUri
          ? [{ uri: input.chartUri }]
          : undefined;

      return deps.notifier.send({
        chatId: watch.notifications.telegram_chat_id,
        text,
        images,
      });
    },

    async notifyTelegramRejected(input: {
      watchId: string;
      asset: string;
      timeframe: string;
      reasoning: string;
    }): Promise<{ messageId: number } | null> {
      const watch = deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notifications.notify_on.includes("rejected")) return null;
      return deps.notifier.send({
        chatId: watch.notifications.telegram_chat_id,
        text: `❌ Setup ${input.asset} ${input.timeframe} rejected\n\n${input.reasoning}`,
      });
    },

    async notifyTelegramInvalidatedAfterConfirmed(input: {
      watchId: string;
      asset: string;
      timeframe: string;
      reason: string;
    }): Promise<{ messageId: number } | null> {
      const watch = deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notifications.notify_on.includes("invalidated_after_confirmed")) return null;
      return deps.notifier.send({
        chatId: watch.notifications.telegram_chat_id,
        text: `⚠️ ${input.asset} ${input.timeframe} invalidated post-confirmation\nReason: ${input.reason}`,
      });
    },
  };
}

function extractObservations(payload: EventPayload): unknown[] {
  if (
    payload.type === "Strengthened" ||
    payload.type === "Weakened" ||
    payload.type === "Neutral"
  ) {
    return payload.data.observations;
  }
  return [];
}

function extractReasoning(payload: EventPayload): string | null {
  if (payload.type === "Strengthened" || payload.type === "Weakened") {
    return payload.data.reasoning;
  }
  return null;
}
