import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { encodeSetupCallback } from "@adapters/notify/setupCallbackFormat";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import { InvalidConfigError } from "@domain/errors";
// loadPrompt is still used for finalizer (not managed by PromptBuilder)
import type { EventPayload } from "@domain/events/schemas";
import type { NewEvent, SetupStateUpdate } from "@domain/ports/EventStore";
import type { ReviewerLlmOutput } from "@domain/schemas/ReviewerOutput";
import { ReviewerLlmOutputSchema } from "@domain/schemas/ReviewerOutput";
import type { Verdict } from "@domain/schemas/Verdict";
import { VerdictSchema } from "@domain/schemas/Verdict";
import { renderHtfChart } from "@domain/services/htfChartRenderer";
import { computeHtfContext } from "@domain/services/htfContext";
import { inferImageMimeType } from "@domain/services/imageMimeType";
import { computeInputHash } from "@domain/services/inputHash";
import { classifyRegime } from "@domain/services/marketRegime";
import { getSession, getSessionState } from "@domain/services/marketSession";
import { getTradingSession } from "@domain/services/tradingSession";
import { isTerminal } from "@domain/state-machine/setupTransitions";
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
      patternCategory: "event" | "accumulation";
      expectedMaturationTicks: number;
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
        patternCategory: input.patternCategory,
        expectedMaturationTicks: input.expectedMaturationTicks,
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

      const indicatorParams: Record<string, Record<string, unknown>> = {};
      for (const [id, cfg] of Object.entries(watch.indicators)) {
        if (cfg?.enabled && cfg.params) {
          indicatorParams[id] = cfg.params as Record<string, unknown>;
        }
      }
      const inputHash = computeInputHash({
        setupId: input.setupId,
        promptVersion,
        ohlcvSnapshot: ohlcvBuf.toString("hex").slice(0, 64),
        chartUri: snap.chartUri,
        indicators: snap.indicators as unknown as Record<string, number>,
        indicatorParams,
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

      // Reviewer gets the HTF text context + funding rate context.
      // Live price = the snapshot's actual lastClose (set at creation from the
      // last OHLCV candle). The previous proxy `recentHigh` was the 50-period
      // high — biased toward 1.0 in `positionInWeeklyRange` and just wrong.
      const fetcher = deps.marketDataFetchers.get(watch.asset.source);
      const livePrice = snap.lastClose ?? ((snap.indicators as Record<string, unknown>).recentHigh as number | undefined) ?? 0;
      const htf = fetcher
        ? await computeHtfContext({
            marketDataFetcher: fetcher,
            asset: watch.asset.symbol,
            livePrice,
          })
        : null;

      // Funding/OI: only meaningful for crypto perp-tradable assets. The
      // provider returns null for unsupported symbols (Yahoo equities,
      // exotic Binance pairs without a perp). Failures don't block the
      // reviewer — the prompt simply omits the section.
      const fundingProvider = deps.fundingRateProviders.get(watch.asset.source);
      const funding = fundingProvider
        ? await fundingProvider.fetchSnapshot(watch.asset.symbol)
        : null;

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
        fresh: { lastClose: snap.lastClose ?? 0, scalars, tickAt: snap.tickAt },
        htf,
        funding,
        activeLessons: activeLessons.map((l) => ({ title: l.title, body: l.body })),
        indicatorsMatrix: watch.indicators,
      });

      // Round 1: tick chart only.
      const round1Images = [
        { sourceUri: snap.chartUri, mimeType: inferImageMimeType(snap.chartUri) },
      ];
      const round1 = await resolveAndCall(
        watch.analyzers.reviewer.provider,
        {
          systemPrompt: deps.promptBuilder.reviewerSystemPrompt,
          userPrompt,
          images: round1Images,
          model: watch.analyzers.reviewer.model,
          maxTokens: watch.analyzers.reviewer.max_tokens,
          responseSchema: ReviewerLlmOutputSchema,
        },
        deps.llmProviders,
      );
      await deps.llmCallStore.record({
        watchId: input.watchId,
        setupId: input.setupId,
        stage: "reviewer",
        provider: round1.usedProvider,
        model: watch.analyzers.reviewer.model,
        promptTokens: round1.output.promptTokens,
        completionTokens: round1.output.completionTokens,
        cacheReadTokens: round1.output.cacheReadTokens ?? 0,
        cacheCreateTokens: round1.output.cacheWriteTokens ?? 0,
        costUsd: round1.output.costUsd,
        latencyMs: round1.output.latencyMs,
      });

      let finalParsed = round1.output.parsed as ReviewerLlmOutput;
      let totalCost = round1.output.costUsd;
      let usedProvider = round1.usedProvider;
      // Effective prompt version reported on the persisted event. Round-2
      // appends the HTF-chart directive to the user prompt; tag it explicitly
      // so cache lookups and audit trails distinguish the two prompts.
      let effectivePromptVersion = promptVersion;

      // Round 2 (on-demand): if reviewer asked for the HTF chart, render a
      // daily chart and replay the call so it can refine its judgment with
      // the wider structure visible. Only one extra round — no recursion.
      if (finalParsed.request_additional?.htfChart === true && fetcher) {
        childLog.info(
          { reason: finalParsed.request_additional.reason ?? "unspecified" },
          "reviewer requested HTF chart, replaying with daily attached",
        );
        try {
          const htfChartUri = await renderHtfChart({
            chartRenderer: deps.chartRenderer,
            indicatorCalculator: deps.indicatorCalculator,
            indicatorRegistry: deps.indicatorRegistry,
            artifactStore: deps.artifactStore,
            fetcher,
            asset: watch.asset.symbol,
          });
          const round2Images = [
            ...round1Images,
            { sourceUri: htfChartUri, mimeType: inferImageMimeType(htfChartUri) },
          ];
          const round2 = await resolveAndCall(
            watch.analyzers.reviewer.provider,
            {
              systemPrompt: deps.promptBuilder.reviewerSystemPrompt,
              userPrompt: `${userPrompt}\n\n## Additional context: HTF (daily) chart attached as 2nd image\n\nThe daily chart you requested is now attached. Update your verdict with this extra structural context. Do NOT request additional artifacts in this round — answer with a final verdict.`,
              images: round2Images,
              model: watch.analyzers.reviewer.model,
              maxTokens: watch.analyzers.reviewer.max_tokens,
              responseSchema: ReviewerLlmOutputSchema,
            },
            deps.llmProviders,
          );
          await deps.llmCallStore.record({
            watchId: input.watchId,
            setupId: input.setupId,
            stage: "reviewer_htf_chart",
            provider: round2.usedProvider,
            model: watch.analyzers.reviewer.model,
            promptTokens: round2.output.promptTokens,
            completionTokens: round2.output.completionTokens,
            cacheReadTokens: round2.output.cacheReadTokens ?? 0,
            cacheCreateTokens: round2.output.cacheWriteTokens ?? 0,
            costUsd: round2.output.costUsd,
            latencyMs: round2.output.latencyMs,
          });
          finalParsed = round2.output.parsed as ReviewerLlmOutput;
          totalCost += round2.output.costUsd;
          usedProvider = round2.usedProvider;
          effectivePromptVersion = `${promptVersion}+htf2`;
        } catch (err) {
          childLog.warn(
            { err: (err as Error).message },
            "HTF chart render/replay failed, falling back to round-1 verdict",
          );
        }
      }

      // Strip the wire-only request_additional field before persisting.
      const { request_additional: _unused, ...persistedFields } = finalParsed;
      const verdict = VerdictSchema.parse(persistedFields) as Verdict;

      childLog.info(
        {
          verdict: verdict.type,
          costUsd: totalCost,
          provider: usedProvider,
          model: watch.analyzers.reviewer.model,
        },
        "runReviewer complete",
      );
      return {
        verdictJson: JSON.stringify(verdict),
        costUsd: totalCost,
        eventAlreadyExisted: false,
        inputHash,
        promptVersion: effectivePromptVersion,
        provider: usedProvider,
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

      // Finalizer is the gatekeeper — always include HTF text + chart, no
      // tool-call shortcut. We're about to fire real capital, no half-measures.
      // Pull the latest tick snapshot for the watch to get fresh indicators
      // (events don't carry indicator state) AND the live price (snapshot's
      // lastClose). Previous code used setup.invalidationLevel as a price
      // proxy — that's the stop-loss, completely wrong.
      const latestSnap = await deps.tickSnapshotStore.latestForWatch(input.watchId);
      const fetcher = deps.marketDataFetchers.get(watch.asset.source);
      const livePrice = latestSnap?.lastClose ?? setup.invalidationLevel ?? 0;
      const htf = fetcher
        ? await computeHtfContext({
            marketDataFetcher: fetcher,
            asset: watch.asset.symbol,
            livePrice,
          })
        : null;
      let htfChartUri: string | null = null;
      if (fetcher) {
        try {
          htfChartUri = await renderHtfChart({
            chartRenderer: deps.chartRenderer,
            indicatorCalculator: deps.indicatorCalculator,
            artifactStore: deps.artifactStore,
            fetcher,
            asset: watch.asset.symbol,
          });
        } catch (err) {
          childLog.warn({ err: (err as Error).message }, "finalizer HTF chart render failed");
        }
      }

      const fundingProvider = deps.fundingRateProviders.get(watch.asset.source);
      const funding = fundingProvider
        ? await fundingProvider.fetchSnapshot(watch.asset.symbol)
        : null;

      // Regime classification needs CURRENT indicators. Events don't carry
      // them (StrengthenedPayload schema has no `indicators` field, the old
      // `extractIndicators` always returned null). Pull from the latest tick
      // snapshot — it has the freshest indicator state.
      const regime = latestSnap ? classifyRegime(latestSnap.indicators, htf) : null;
      const session = getTradingSession(deps.clock.now());

      const finalizerPrompt = await loadPrompt("finalizer");
      // Reviewer-tick count = setup events excluding SetupCreated, Confirmed,
      // Expired, and other non-reviewer event types. Drives the maturation rule.
      const actualReviewerTicks = history.filter((e) =>
        ["Strengthened", "Weakened", "Neutral"].includes(e.type),
      ).length;

      const minRR = watch.setup_lifecycle.min_risk_reward_ratio;
      const costs = {
        fees_pct: watch.costs.fees_pct,
        slippage_pct: watch.costs.slippage_pct,
        totalPct: (watch.costs.fees_pct + watch.costs.slippage_pct).toFixed(3),
      };

      const userPrompt = finalizerPrompt.render({
        setup: {
          id: setup.id,
          asset: setup.asset,
          timeframe: setup.timeframe,
          patternHint: setup.patternHint,
          patternCategory: setup.patternCategory,
          expectedMaturationTicks: setup.expectedMaturationTicks ?? "(not declared)",
          direction: setup.direction,
          currentScore: setup.currentScore,
          invalidationLevel: setup.invalidationLevel,
        },
        minRiskRewardRatio: minRR,
        costs,
        historyCount: history.length,
        actualReviewerTicks,
        history: history.map((e) => ({
          sequence: e.sequence,
          type: e.type,
          scoreAfter: e.scoreAfter,
        })),
        htf,
        funding,
        regime,
        session,
        activeLessons: activeLessons.map((l) => ({ title: l.title, body: l.body })),
      });

      const finalizerImages = htfChartUri
        ? [{ sourceUri: htfChartUri, mimeType: inferImageMimeType(htfChartUri) }]
        : undefined;
      const result = await resolveAndCall(
        watch.analyzers.finalizer.provider,
        {
          systemPrompt: finalizerPrompt.systemPrompt,
          userPrompt,
          images: finalizerImages,
          model: watch.analyzers.finalizer.model,
          maxTokens: watch.analyzers.finalizer.max_tokens,
          responseSchema: FinalizerOutputSchema,
        },
        deps.llmProviders,
      );

      const decision = result.output.parsed as { go: boolean };
      await deps.llmCallStore.record({
        watchId: input.watchId,
        setupId: input.setupId,
        stage: "finalizer",
        provider: result.usedProvider,
        model: watch.analyzers.finalizer.model,
        promptTokens: result.output.promptTokens,
        completionTokens: result.output.completionTokens,
        cacheReadTokens: result.output.cacheReadTokens ?? 0,
        cacheCreateTokens: result.output.cacheWriteTokens ?? 0,
        costUsd: result.output.costUsd,
        latencyMs: result.output.latencyMs,
      });
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
      /** Snapshotted at workflow start; falls back to live `watch.include_reasoning` for back-compat. */
      includeReasoning?: boolean;
      /** Snapshotted at workflow start; falls back to live `watch.include_chart_image` for back-compat. */
      includeChartImage?: boolean;
    }): Promise<{ messageId: number } | null> {
      const childLog = log.child({ watchId: input.watchId, asset: input.asset });
      const watch = await deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notify_on.includes("confirmed")) {
        childLog.debug({ event: "confirmed" }, "notification skipped (not in notify_on)");
        return null;
      }

      const includeReasoning = input.includeReasoning ?? watch.include_reasoning;
      const includeChartImage = input.includeChartImage ?? watch.include_chart_image;

      const arrow = input.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      const tpStr = input.takeProfit.length ? `\nTP: ${input.takeProfit.join(" / ")}` : "";
      const reasoning = includeReasoning ? `\n\n${input.reasoning}` : "";
      const text = `${arrow} ${input.asset} ${input.timeframe}\nEntry: ${input.entry}\nSL: ${input.stopLoss}${tpStr}${reasoning}`;

      const images =
        includeChartImage && input.chartUri ? [{ uri: input.chartUri }] : undefined;

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

    /**
     * Notification fired right after the detector creates a new setup. Includes
     * an inline "Kill setup" button so the user can short-circuit the
     * reviewer/finalizer chain on a setup they don't want followed.
     */
    async notifyTelegramSetupCreated(input: {
      watchId: string;
      asset: string;
      timeframe: string;
      setupId: string;
      patternHint: string;
      direction: "LONG" | "SHORT";
      initialScore: number;
      rawObservation: string;
      invalidationLevel: number;
      chartUri?: string;
      /** Snapshotted at workflow start; falls back to live `watch.include_chart_image` for back-compat. */
      includeChartImage?: boolean;
    }): Promise<{ messageId: number } | null> {
      const childLog = log.child({ watchId: input.watchId, asset: input.asset });
      const watch = await deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notify_on.includes("setup_created")) {
        childLog.debug({ event: "setup_created" }, "notification skipped (not in notify_on)");
        return null;
      }

      const includeChartImage = input.includeChartImage ?? watch.include_chart_image;

      const arrow = input.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      const text = [
        `🆕 New setup detected — ${input.watchId}`,
        `${input.asset} ${input.timeframe} | ${arrow} | pattern=${input.patternHint}`,
        `Score initial: ${input.initialScore}/100`,
        `Invalidation: ${input.invalidationLevel}`,
        "",
        input.rawObservation,
      ].join("\n");

      const images =
        includeChartImage && input.chartUri ? [{ uri: input.chartUri }] : undefined;

      const result = await deps.notifier.sendWithButtons({
        chatId: deps.infra.notifications.telegram.chat_id,
        text,
        images,
        buttons: [
          [
            {
              text: "❌ Kill setup",
              callbackData: encodeSetupCallback({ action: "kill", setupId: input.setupId }),
            },
          ],
        ],
      });
      childLog.info(
        { event: "setup_created", setupId: input.setupId },
        "telegram setup_created sent",
      );
      return result;
    },

    /**
     * Notification fired when the reviewer returns a STRENGTHEN or WEAKEN
     * verdict. Includes the kill button so the user can pull the plug if a
     * STRENGTHEN moved the setup into territory they don't believe.
     */
    async notifyTelegramReviewerVerdict(input: {
      watchId: string;
      asset: string;
      timeframe: string;
      setupId: string;
      verdict: "STRENGTHEN" | "WEAKEN";
      scoreDelta: number;
      scoreAfter: number;
      reasoning: string;
      /** Snapshotted at workflow start; falls back to live `watch.include_reasoning` for back-compat. */
      includeReasoning?: boolean;
    }): Promise<{ messageId: number } | null> {
      const childLog = log.child({ watchId: input.watchId, asset: input.asset });
      const watch = await deps.watchById(input.watchId);
      if (!watch) return null;
      const event =
        input.verdict === "STRENGTHEN" ? "setup_strengthened" : "setup_weakened";
      if (!watch.notify_on.includes(event)) {
        childLog.debug({ event }, "notification skipped (not in notify_on)");
        return null;
      }

      const includeReasoning = input.includeReasoning ?? watch.include_reasoning;
      const scoreBefore = input.scoreAfter - input.scoreDelta;
      // Symmetric template — the verdict already encodes the sign, so we
      // build it explicitly from `Math.abs` rather than relying on a leading
      // `+` for STRENGTHEN and a natural `-` for WEAKEN.
      const sign = input.verdict === "STRENGTHEN" ? "+" : "-";
      const emoji = input.verdict === "STRENGTHEN" ? "💪" : "💔";
      const header = `${emoji} ${input.verdict} ${sign}${Math.abs(input.scoreDelta)} — ${input.asset} ${input.timeframe}`;
      const text = [
        header,
        `Score: ${scoreBefore}→${input.scoreAfter}`,
        "",
        includeReasoning ? input.reasoning : "",
      ]
        .filter((l) => l !== "")
        .join("\n");

      const result = await deps.notifier.sendWithButtons({
        chatId: deps.infra.notifications.telegram.chat_id,
        text,
        buttons: [
          [
            {
              text: "❌ Kill setup",
              callbackData: encodeSetupCallback({ action: "kill", setupId: input.setupId }),
            },
          ],
        ],
      });
      childLog.info({ event, setupId: input.setupId }, "telegram reviewer verdict sent");
      return result;
    },

    /**
     * Confirmation message echoed back after a user-issued kill via the inline
     * Telegram button. Sent without a kill button (the setup is already
     * terminal).
     */
    async notifyTelegramSetupKilled(input: {
      watchId: string;
      asset: string;
      timeframe: string;
      setupId: string;
    }): Promise<{ messageId: number } | null> {
      const childLog = log.child({ watchId: input.watchId, asset: input.asset });
      const watch = await deps.watchById(input.watchId);
      if (!watch) return null;
      if (!watch.notify_on.includes("setup_killed")) {
        childLog.debug({ event: "setup_killed" }, "notification skipped (not in notify_on)");
        return null;
      }
      const result = await deps.notifier.send({
        chatId: deps.infra.notifications.telegram.chat_id,
        text: `☠️ Setup killed by user — ${input.asset} ${input.timeframe}`,
      });
      childLog.info(
        { event: "setup_killed", setupId: input.setupId },
        "telegram setup_killed sent",
      );
      return result;
    },

    /**
     * Persists a Killed event and transitions the setup to the terminal
     * KILLED status. Called from the workflow's killSignal handler.
     *
     * Idempotent: a no-op when the setup is already in a terminal status
     * (CLOSED / INVALIDATED / EXPIRED / REJECTED / KILLED). This covers
     * three legitimate races where the activity may be re-invoked on a
     * non-active setup:
     *   - Activity retry after a transient DB blip mid-append (the row was
     *     committed but the worker missed the ack).
     *   - Workflow history replay after a worker restart (Temporal re-runs
     *     activities that did not complete from its perspective).
     *   - Late kill arriving after the setup naturally terminated (e.g.
     *     finalizer rejected and persisted REJECTED before the kill signal
     *     was delivered to the workflow).
     */
    async killSetup(input: { setupId: string; reason: string }): Promise<void> {
      const setup = await deps.setupRepo.get(input.setupId);
      if (!setup) {
        log.warn({ setupId: input.setupId }, "killSetup: setup not found, ignoring");
        return;
      }
      if (isTerminal(setup.status)) {
        log.info(
          { setupId: input.setupId, status: setup.status },
          "killSetup: setup already terminal, no-op",
        );
        return;
      }
      const before = setup.status;
      await deps.eventStore.append(
        {
          setupId: input.setupId,
          stage: "system",
          actor: "user_kill",
          type: "Killed",
          scoreDelta: 0,
          scoreAfter: setup.currentScore,
          statusBefore: before,
          statusAfter: "KILLED",
          payload: { type: "Killed", data: { reason: input.reason } },
        },
        {
          score: setup.currentScore,
          status: "KILLED",
          invalidationLevel: setup.invalidationLevel,
        },
      );
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
