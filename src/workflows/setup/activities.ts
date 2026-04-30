import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import { InvalidConfigError } from "@domain/errors";
// loadPrompt is still used for finalizer (not managed by PromptBuilder)
import type { EventPayload } from "@domain/events/schemas";
import type { NewEvent, SetupStateUpdate } from "@domain/ports/EventStore";
import type { Verdict } from "@domain/schemas/Verdict";
import { VerdictSchema } from "@domain/schemas/Verdict";
import { computeInputHash } from "@domain/services/inputHash";
import { getSession, getSessionState } from "@domain/services/marketSession";
import { getLogger } from "@observability/logger";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { ensurePriceMonitorStarted } from "@workflows/price-monitor/ensureRunning";
import { z } from "zod";

const log = getLogger({ component: "setup-activities" });

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
      const created = await deps.setupRepo.create({
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
      const watch = await deps.watchById(input.watchId);
      if (watch) {
        await ensurePriceMonitorStarted(deps.temporalClient, deps.infra, {
          symbol: input.asset,
          source: watch.asset.source,
        });
      }
      return created;
    },

    async persistEvent(input: { event: NewEvent; setupUpdate: SetupStateUpdate }) {
      return deps.eventStore.append(input.event, input.setupUpdate);
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
      skipReason?: "market_closed";
    }> {
      const childLog = log.child({ setupId: input.setupId, watchId: input.watchId });
      childLog.info({ tickSnapshotId: input.tickSnapshotId }, "runReviewer starting");
      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);

      let marketState: ReturnType<typeof getSessionState> | null = null;
      try {
        const session = getSession(watch);
        marketState = getSessionState(session, deps.clock.now());
      } catch (e) {
        childLog.warn(
          { err: (e as Error).message },
          "runReviewer: skipping market-hours guard (invalid asset metadata)",
        );
      }

      if (marketState && !marketState.isOpen) {
        childLog.info(
          { nextOpenAt: marketState.nextOpenAt?.toISOString() },
          "runReviewer skipped: market closed",
        );
        return {
          verdictJson: "",
          costUsd: 0,
          eventAlreadyExisted: false,
          inputHash: "",
          promptVersion: "",
          provider: "",
          model: "",
          skipReason: "market_closed",
        };
      }

      const setup = await deps.setupRepo.get(input.setupId);
      if (!setup) throw new Error(`Setup ${input.setupId} not found`);
      const snap = await deps.tickSnapshotStore.get(input.tickSnapshotId);
      if (!snap) throw new Error(`TickSnapshot ${input.tickSnapshotId} not found`);

      const ohlcvBuf = await deps.artifactStore.get(snap.ohlcvUri);
      await deps.promptBuilder.warmUp();
      const promptVersion = deps.promptBuilder.reviewerVersion;

      const activeLessons = watch.feedback.injection.reviewer
        ? await deps.lessonStore.listActive({
            watchId: input.watchId,
            category: "reviewing",
            limit: watch.feedback.max_active_lessons_per_category,
          })
        : [];
      if (activeLessons.length > 0) {
        await deps.lessonStore.incrementUsage(activeLessons.map((l) => l.id));
      }

      const inputHash = computeInputHash({
        setupId: input.setupId,
        promptVersion,
        ohlcvSnapshot: ohlcvBuf.toString("hex").slice(0, 64),
        chartUri: snap.chartUri,
        indicators: snap.indicators as unknown as Record<string, number>,
        activeLessonIds: activeLessons.map((l) => l.id).sort(),
      });

      const cached = await deps.eventStore.findByInputHash(input.setupId, inputHash);
      if (cached) {
        childLog.info({ inputHash, cached: true }, "runReviewer cache hit, skipping LLM");
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
      const scalars = (snap.indicators ?? {}) as Record<string, unknown>;
      const userPrompt = await deps.promptBuilder.buildReviewerPrompt({
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
        fresh: { lastClose: 0, scalars, tickAt: snap.tickAt },
        activeLessons: activeLessons.map((l) => ({ title: l.title, body: l.body })),
        indicatorsMatrix: watch.indicators,
      });

      const result = await resolveAndCall(
        watch.analyzers.reviewer.provider,
        {
          systemPrompt: deps.promptBuilder.reviewerSystemPrompt,
          userPrompt,
          images: [{ sourceUri: snap.chartUri, mimeType: "image/png" }],
          model: watch.analyzers.reviewer.model,
          maxTokens: watch.analyzers.reviewer.max_tokens,
          responseSchema: VerdictSchema,
        },
        deps.llmProviders,
      );
      const verdict = result.output.parsed as Verdict;
      childLog.info(
        {
          verdict: verdict.type,
          costUsd: result.output.costUsd,
          provider: result.usedProvider,
          model: watch.analyzers.reviewer.model,
        },
        "runReviewer complete",
      );
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

    async runFinalizer(input: { setupId: string; watchId: string }): Promise<{
      decisionJson: string;
      costUsd: number;
      promptVersion: string;
      skipReason?: "market_closed";
    }> {
      const childLog = log.child({ setupId: input.setupId, watchId: input.watchId });
      childLog.info({}, "runFinalizer starting");
      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new InvalidConfigError(`Unknown watch: ${input.watchId}`);

      let marketState: ReturnType<typeof getSessionState> | null = null;
      try {
        const session = getSession(watch);
        marketState = getSessionState(session, deps.clock.now());
      } catch (e) {
        childLog.warn(
          { err: (e as Error).message },
          "runFinalizer: skipping market-hours guard (invalid asset metadata)",
        );
      }

      if (marketState && !marketState.isOpen) {
        childLog.info(
          { nextOpenAt: marketState.nextOpenAt?.toISOString() },
          "runFinalizer skipped: market closed",
        );
        return {
          decisionJson: "",
          costUsd: 0,
          promptVersion: "",
          skipReason: "market_closed",
        };
      }

      const setup = await deps.setupRepo.get(input.setupId);
      if (!setup) throw new Error(`Setup ${input.setupId} not found`);
      const history = await deps.eventStore.listForSetup(input.setupId);

      const activeLessons = watch.feedback.injection.finalizer
        ? await deps.lessonStore.listActive({
            watchId: input.watchId,
            category: "finalizing",
            limit: watch.feedback.max_active_lessons_per_category,
          })
        : [];
      if (activeLessons.length > 0) {
        await deps.lessonStore.incrementUsage(activeLessons.map((l) => l.id));
      }

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
        activeLessons: activeLessons.map((l) => ({ title: l.title, body: l.body })),
      });

      const result = await resolveAndCall(
        watch.analyzers.finalizer.provider,
        {
          systemPrompt: finalizerPrompt.systemPrompt,
          userPrompt,
          model: watch.analyzers.finalizer.model,
          maxTokens: watch.analyzers.finalizer.max_tokens,
          responseSchema: FinalizerOutputSchema,
        },
        deps.llmProviders,
      );

      const decision = result.output.parsed as { go: boolean };
      childLog.info(
        {
          go: decision.go,
          costUsd: result.output.costUsd,
          provider: result.usedProvider,
          model: watch.analyzers.finalizer.model,
        },
        "runFinalizer complete",
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
      const childLog = log.child({ watchId: input.watchId, asset: input.asset });
      const watch = await deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notify_on.includes("confirmed")) {
        childLog.debug({ event: "confirmed" }, "notification skipped (not in notify_on)");
        return null;
      }

      const arrow = input.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      const tpStr = input.takeProfit.length ? `\nTP: ${input.takeProfit.join(" / ")}` : "";
      const reasoning = watch.include_reasoning ? `\n\n${input.reasoning}` : "";
      const text = `${arrow} ${input.asset} ${input.timeframe}\nEntry: ${input.entry}\nSL: ${input.stopLoss}${tpStr}${reasoning}`;

      const images =
        watch.include_chart_image && input.chartUri ? [{ uri: input.chartUri }] : undefined;

      const result = await deps.notifier.send({
        chatId: deps.infra.notifications.telegram.chat_id,
        text,
        images,
      });
      childLog.info({ event: "confirmed", entry: input.entry }, "telegram sent");
      return result;
    },

    async notifyTelegramRejected(input: {
      watchId: string;
      asset: string;
      timeframe: string;
      reasoning: string;
    }): Promise<{ messageId: number } | null> {
      const childLog = log.child({ watchId: input.watchId, asset: input.asset });
      const watch = await deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notify_on.includes("rejected")) {
        childLog.debug({ event: "rejected" }, "notification skipped (not in notify_on)");
        return null;
      }
      const result = await deps.notifier.send({
        chatId: deps.infra.notifications.telegram.chat_id,
        text: `❌ Setup ${input.asset} ${input.timeframe} rejected\n\n${input.reasoning}`,
      });
      childLog.info({ event: "rejected" }, "telegram sent");
      return result;
    },

    async notifyTelegramInvalidatedAfterConfirmed(input: {
      watchId: string;
      asset: string;
      timeframe: string;
      reason: string;
    }): Promise<{ messageId: number } | null> {
      const childLog = log.child({ watchId: input.watchId, asset: input.asset });
      const watch = await deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notify_on.includes("invalidated_after_confirmed")) {
        childLog.debug(
          { event: "invalidated_after_confirmed" },
          "notification skipped (not in notify_on)",
        );
        return null;
      }
      const result = await deps.notifier.send({
        chatId: deps.infra.notifications.telegram.chat_id,
        text: `⚠️ ${input.asset} ${input.timeframe} invalidated post-confirmation\nReason: ${input.reason}`,
      });
      childLog.info({ event: "invalidated_after_confirmed" }, "telegram sent");
      return result;
    },

    async notifyTelegramTPHit(input: {
      watchId: string;
      asset: string;
      timeframe: string;
      level: number;
      index: number;
      isFinal: boolean;
    }): Promise<{ messageId: number } | null> {
      const childLog = log.child({ watchId: input.watchId, asset: input.asset });
      const watch = await deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notify_on.includes("tp_hit")) {
        childLog.debug({ event: "tp_hit" }, "notification skipped (not in notify_on)");
        return null;
      }
      const tpLabel = `TP${input.index + 1}`;
      const finalStr = input.isFinal ? " (final, position closed)" : "";
      const result = await deps.notifier.send({
        chatId: deps.infra.notifications.telegram.chat_id,
        text: `🎯 ${tpLabel} hit on ${input.asset} ${input.timeframe} @ ${input.level}${finalStr}`,
      });
      childLog.info(
        { event: "tp_hit", level: input.level, index: input.index, isFinal: input.isFinal },
        "telegram sent",
      );
      return result;
    },

    async notifyTelegramSLHit(input: {
      watchId: string;
      asset: string;
      timeframe: string;
      level: number;
    }): Promise<{ messageId: number } | null> {
      const childLog = log.child({ watchId: input.watchId, asset: input.asset });
      const watch = await deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notify_on.includes("sl_hit")) {
        childLog.debug({ event: "sl_hit" }, "notification skipped (not in notify_on)");
        return null;
      }
      const result = await deps.notifier.send({
        chatId: deps.infra.notifications.telegram.chat_id,
        text: `🛑 SL hit on ${input.asset} ${input.timeframe} @ ${input.level} — position closed`,
      });
      childLog.info({ event: "sl_hit", level: input.level }, "telegram sent");
      return result;
    },

    async notifyTelegramExpired(input: {
      watchId: string;
      asset: string;
      timeframe: string;
    }): Promise<{ messageId: number } | null> {
      const childLog = log.child({ watchId: input.watchId, asset: input.asset });
      const watch = await deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notify_on.includes("expired")) {
        childLog.debug({ event: "expired" }, "notification skipped (not in notify_on)");
        return null;
      }
      const result = await deps.notifier.send({
        chatId: deps.infra.notifications.telegram.chat_id,
        text: `⏱ Setup expired (TTL reached) on ${input.asset} ${input.timeframe}`,
      });
      childLog.info({ event: "expired" }, "telegram sent");
      return result;
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
