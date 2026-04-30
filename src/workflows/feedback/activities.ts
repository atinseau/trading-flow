import { createHash, randomUUID } from "node:crypto";
import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import type { CloseOutcome } from "@domain/feedback/closeOutcome";
import type { LessonAction, LessonCategory } from "@domain/feedback/lessonAction";
import { validateActions } from "@domain/feedback/validateActions";
import type { FeedbackContextChunk } from "@domain/ports/FeedbackContextProvider";
import type { FeedbackOutput } from "@domain/schemas/FeedbackOutput";
import { FeedbackOutputSchema } from "@domain/schemas/FeedbackOutput";
import { computeFeedbackInputHash } from "@domain/services/feedbackInputHash";
import { getLogger } from "@observability/logger";
import { buildFeedbackContext } from "@workflows/feedback/buildContext";
import type { ActivityDeps } from "../activityDependencies";

const log = getLogger({ component: "feedback-activities" });

export type GatherFeedbackContextInput = {
  setupId: string;
  watchId: string;
  closeOutcome: CloseOutcome;
};

export type GatherFeedbackContextResult = {
  contextRef: string;
  chunkHashes: string[];
};

export type RunFeedbackAnalysisInput = {
  setupId: string;
  watchId: string;
  contextRef: string;
  chunkHashes: string[];
};

export type RunFeedbackAnalysisResult = {
  summary: string;
  actions: LessonAction[];
  provider: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  costUsd: number;
  latencyMs: number;
  /**
   * True if the analysis was satisfied from a prior persisted run with the same
   * inputHash. When true:
   *   - `actions` is `[]` (the prior run already persisted its events)
   *   - `costUsd` is 0 (no new LLM call was made)
   *
   * The workflow MUST short-circuit and skip applyLessonChanges when this is
   * true; otherwise observability is misleading (logs would show 0 changes
   * applied, hiding that the prior run handled the work). See Phase 8 workflow.
   */
  cached: boolean;
};

export type ApplyLessonChangesInput = {
  setupId: string;
  watchId: string;
  closeReason: string;
  proposedActions: LessonAction[];
  feedbackPromptVersion: string;
  provider: string;
  model: string;
  inputHash: string;
  costUsd: number;
  latencyMs: number;
};

export type ApplyLessonChangesResult = {
  changesApplied: number;
  pendingApprovalsCreated: number;
  costUsd: number;
};

type SerializedContextChunk = {
  providerId: string;
  title: string;
  content:
    | { kind: "markdown"; value: string }
    | { kind: "image"; artifactUri: string; mimeType: string };
};

type SerializedContext = {
  scope: {
    setupId: string;
    watchId: string;
    asset: string;
    timeframe: string;
    closeOutcome: CloseOutcome;
    setupCreatedAt: string;
    setupClosedAt: string;
    confirmedAt: string | null;
    scoreAtClose: number;
  };
  chunks: SerializedContextChunk[];
};

export type FeedbackActivities = ReturnType<typeof buildFeedbackActivities>;

export function buildFeedbackActivities(deps: ActivityDeps) {
  return {
    async gatherFeedbackContext(
      input: GatherFeedbackContextInput,
    ): Promise<GatherFeedbackContextResult> {
      const childLog = log.child({ setupId: input.setupId, watchId: input.watchId });
      const setup = await deps.setupRepo.get(input.setupId);
      if (!setup) throw new Error(`Setup ${input.setupId} not found`);

      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new Error(`Unknown watch: ${input.watchId}`);

      const events = await deps.eventStore.listForSetup(input.setupId);
      const confirmedEvent = events.find((e) => e.type === "Confirmed");
      // Prefer the event-sourced source of truth (latest event's scoreAfter).
      // Fall back to the projection (`setup.currentScore`) and finally 0 if
      // neither is available — events are already loaded for `confirmedEvent`
      // detection so this is free.
      const scoreAtClose = events[events.length - 1]?.scoreAfter ?? setup.currentScore ?? 0;

      const scope = {
        setupId: setup.id,
        watchId: input.watchId,
        asset: setup.asset,
        timeframe: setup.timeframe,
        closeOutcome: input.closeOutcome,
        setupCreatedAt: setup.createdAt,
        // Defensive fallback: in normal flow `closedAt` is always set by
        // markClosed before feedback fires, but the column is nullable so we
        // guard against bad ordering by using "now".
        setupClosedAt: setup.closedAt ?? new Date(),
        confirmedAt: confirmedEvent?.occurredAt ?? null,
        scoreAtClose,
      };

      const providers = deps.feedbackContextRegistry.resolveForWatch(
        watch.feedback.context_providers_disabled,
      );
      const chunks = await buildFeedbackContext(scope, providers);

      // Persist chunks as a single JSON artifact and return its uri as `contextRef`
      // so the workflow doesn't carry large payloads (Temporal payload size cap).
      const serialized: SerializedContext = {
        scope: {
          setupId: scope.setupId,
          watchId: scope.watchId,
          asset: scope.asset,
          timeframe: scope.timeframe,
          closeOutcome: scope.closeOutcome,
          setupCreatedAt: scope.setupCreatedAt.toISOString(),
          setupClosedAt: scope.setupClosedAt.toISOString(),
          confirmedAt: scope.confirmedAt ? scope.confirmedAt.toISOString() : null,
          scoreAtClose: scope.scoreAtClose,
        },
        chunks: chunks.map((c) => ({
          providerId: c.providerId,
          title: c.title,
          content: c.content,
        })),
      };
      const stored = await deps.artifactStore.put({
        kind: "feedback-context",
        content: Buffer.from(JSON.stringify(serialized)),
        mimeType: "application/json",
      });
      const chunkHashes = chunks.map((c) =>
        createHash("sha256")
          .update(JSON.stringify({ providerId: c.providerId, content: c.content }))
          .digest("hex"),
      );
      childLog.info({ chunks: chunks.length }, "feedback context gathered");
      return { contextRef: stored.uri, chunkHashes };
    },

    async runFeedbackAnalysis(input: RunFeedbackAnalysisInput): Promise<RunFeedbackAnalysisResult> {
      const childLog = log.child({ setupId: input.setupId, watchId: input.watchId });
      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new Error(`Unknown watch: ${input.watchId}`);

      const analyzer = watch.feedback.analyzer ?? watch.analyzers.feedback;
      if (!analyzer) {
        throw new Error(
          `watch '${input.watchId}' has no feedback analyzer configured (set feedback.analyzer or analyzers.feedback)`,
        );
      }

      const cap = watch.feedback.max_active_lessons_per_category;
      const existingLessons = await Promise.all(
        (["detecting", "reviewing", "finalizing"] as LessonCategory[]).map((cat) =>
          deps.lessonStore.listActive({
            watchId: input.watchId,
            category: cat,
            limit: cap,
          }),
        ),
      );
      const flat = existingLessons.flat();
      const existingLessonIds = flat.map((l) => l.id);

      const feedbackPrompt = await loadPrompt("feedback");
      const inputHash = computeFeedbackInputHash({
        promptVersion: feedbackPrompt.version,
        contextChunkHashes: input.chunkHashes,
        existingLessonIds,
      });

      // Idempotence: replay any prior actions if same hash already persisted.
      const prior = await deps.lessonEventStore.findByInputHash({
        watchId: input.watchId,
        inputHash,
      });
      if (prior.length > 0) {
        childLog.info(
          { inputHash, priorEvents: prior.length },
          "runFeedbackAnalysis: cache hit, returning prior result without LLM call",
        );
        const first = prior[0];
        return {
          summary: "(replayed from existing events)",
          actions: cachedRunReplayActions(prior),
          provider: first?.provider ?? "",
          model: first?.model ?? "",
          promptVersion: feedbackPrompt.version,
          inputHash,
          costUsd: 0,
          latencyMs: 0,
          cached: true,
        };
      }

      // Load context payload from artifact
      const ctxBuf = await deps.artifactStore.get(input.contextRef);
      const ctx = JSON.parse(ctxBuf.toString("utf8")) as SerializedContext;

      const poolStats = await deps.lessonStore.countActiveByCategory(input.watchId);

      const userPrompt = feedbackPrompt.render({
        closeOutcome: ctx.scope.closeOutcome,
        scoreAtClose: ctx.scope.scoreAtClose,
        poolStats,
        maxActivePerCategory: cap,
        existingLessons: flat.map((l) => ({
          id: l.id,
          category: l.category,
          timesReinforced: l.timesReinforced,
          title: l.title,
          body: l.body,
        })),
        contextChunks: ctx.chunks,
      });

      const images = ctx.chunks
        .filter(
          (
            c,
          ): c is FeedbackContextChunk & {
            content: { kind: "image" } & FeedbackContextChunk["content"];
          } => c.content.kind === "image",
        )
        .map((c) => ({
          sourceUri: (c.content as { kind: "image"; artifactUri: string; mimeType: string })
            .artifactUri,
          mimeType: (c.content as { kind: "image"; artifactUri: string; mimeType: string })
            .mimeType,
        }));

      const startedAt = Date.now();
      const result = await resolveAndCall(
        analyzer.provider,
        {
          systemPrompt: feedbackPrompt.systemPrompt,
          userPrompt,
          images: images.length > 0 ? images : undefined,
          model: analyzer.model,
          responseSchema: FeedbackOutputSchema,
        },
        deps.llmProviders,
      );
      const latencyMs = Date.now() - startedAt;
      const parsed = result.output.parsed as FeedbackOutput;

      childLog.info(
        {
          actions: parsed.actions.length,
          costUsd: result.output.costUsd,
          provider: result.usedProvider,
          model: analyzer.model,
        },
        "runFeedbackAnalysis complete",
      );

      return {
        summary: parsed.summary,
        actions: parsed.actions,
        provider: result.usedProvider,
        model: analyzer.model,
        promptVersion: feedbackPrompt.version,
        inputHash,
        costUsd: result.output.costUsd,
        latencyMs,
        cached: false,
      };
    },

    async applyLessonChanges(input: ApplyLessonChangesInput): Promise<ApplyLessonChangesResult> {
      const childLog = log.child({ setupId: input.setupId, watchId: input.watchId });
      const watch = await deps.watchById(input.watchId);
      if (!watch) throw new Error(`Unknown watch: ${input.watchId}`);

      // Defense-in-depth: if the workflow forgets to short-circuit on a cache
      // hit (cached: true → actions: []), bail early with a clear log line so
      // the empty-input case is observable rather than silently doing zero work.
      if (input.proposedActions.length === 0) {
        childLog.info({ inputHash: input.inputHash }, "applyLessonChanges: no actions to apply");
        return {
          changesApplied: 0,
          pendingApprovalsCreated: 0,
          costUsd: input.costUsd,
        };
      }

      const cap = watch.feedback.max_active_lessons_per_category;
      const allActiveByCat = {
        detecting: await deps.lessonStore.listActive({
          watchId: input.watchId,
          category: "detecting",
          limit: cap,
        }),
        reviewing: await deps.lessonStore.listActive({
          watchId: input.watchId,
          category: "reviewing",
          limit: cap,
        }),
        finalizing: await deps.lessonStore.listActive({
          watchId: input.watchId,
          category: "finalizing",
          limit: cap,
        }),
      };
      const pinnedById = new Map<string, boolean>();
      for (const l of [
        ...allActiveByCat.detecting,
        ...allActiveByCat.reviewing,
        ...allActiveByCat.finalizing,
      ]) {
        pinnedById.set(l.id, l.pinned);
      }

      const validation = validateActions(input.proposedActions, {
        watchId: input.watchId,
        watchSymbols: [watch.asset.symbol],
        watchTimeframeStrings: [watch.timeframes.primary, ...watch.timeframes.higher],
        capPerCategory: cap,
        activeByCategory: {
          detecting: allActiveByCat.detecting.map((l) => ({
            id: l.id,
            watchId: l.watchId,
            category: l.category,
            status: l.status,
            pinned: l.pinned,
          })),
          reviewing: allActiveByCat.reviewing.map((l) => ({
            id: l.id,
            watchId: l.watchId,
            category: l.category,
            status: l.status,
            pinned: l.pinned,
          })),
          finalizing: allActiveByCat.finalizing.map((l) => ({
            id: l.id,
            watchId: l.watchId,
            category: l.category,
            status: l.status,
            pinned: l.pinned,
          })),
        },
        pinnedById,
      });

      let changesApplied = 0;
      let pendingApprovalsCreated = 0;

      // Persist auto-rejected actions for audit
      for (const r of validation.rejected) {
        await deps.lessonEventStore.append({
          watchId: input.watchId,
          type: "AutoRejected",
          actor: "system",
          triggerSetupId: input.setupId,
          triggerCloseReason: input.closeReason,
          payload: {
            type: "AutoRejected",
            data: { proposedAction: r.action, reason: r.reason },
          },
          provider: input.provider,
          model: input.model,
          promptVersion: input.feedbackPromptVersion,
          inputHash: input.inputHash,
        });
      }

      // Apply allowed actions
      for (const action of validation.applied) {
        if (action.type === "CREATE") {
          const newId = randomUUID();
          const evt = await deps.lessonEventStore.append({
            watchId: input.watchId,
            lessonId: newId,
            type: "CREATE",
            actor: input.feedbackPromptVersion,
            triggerSetupId: input.setupId,
            triggerCloseReason: input.closeReason,
            payload: {
              type: "CREATE",
              data: {
                category: action.category,
                title: action.title,
                body: action.body,
                rationale: action.rationale,
              },
            },
            provider: input.provider,
            model: input.model,
            promptVersion: input.feedbackPromptVersion,
            inputHash: input.inputHash,
            costUsd: input.costUsd,
            latencyMs: input.latencyMs,
          });
          await deps.lessonStore.create({
            id: newId,
            watchId: input.watchId,
            category: action.category,
            title: action.title,
            body: action.body,
            rationale: action.rationale,
            promptVersion: input.feedbackPromptVersion,
            sourceFeedbackEventId: evt.id,
            status: "PENDING",
          });
          await deps.notifyLessonPending({
            lessonId: newId,
            watchId: input.watchId,
            category: action.category,
            title: action.title,
            body: action.body,
            rationale: action.rationale,
            kind: "CREATE",
            triggerSetupId: input.setupId,
            triggerCloseReason: input.closeReason,
          });
          changesApplied++;
          pendingApprovalsCreated++;
        } else if (action.type === "REINFORCE") {
          await deps.lessonEventStore.append({
            watchId: input.watchId,
            lessonId: action.lessonId,
            type: "REINFORCE",
            actor: input.feedbackPromptVersion,
            triggerSetupId: input.setupId,
            triggerCloseReason: input.closeReason,
            payload: { type: "REINFORCE", data: { reason: action.reason } },
            provider: input.provider,
            model: input.model,
            promptVersion: input.feedbackPromptVersion,
            inputHash: input.inputHash,
          });
          await deps.lessonStore.incrementReinforced(action.lessonId);
          changesApplied++;
        } else if (action.type === "REFINE") {
          const oldLesson = await deps.lessonStore.getById(action.lessonId);
          if (!oldLesson) continue;
          const newId = randomUUID();
          const evt = await deps.lessonEventStore.append({
            watchId: input.watchId,
            lessonId: newId,
            type: "REFINE",
            actor: input.feedbackPromptVersion,
            triggerSetupId: input.setupId,
            triggerCloseReason: input.closeReason,
            payload: {
              type: "REFINE",
              data: {
                supersedesLessonId: action.lessonId,
                before: { title: oldLesson.title, body: oldLesson.body },
                after: { title: action.newTitle, body: action.newBody },
                rationale: action.rationale,
              },
            },
            provider: input.provider,
            model: input.model,
            promptVersion: input.feedbackPromptVersion,
            inputHash: input.inputHash,
          });
          await deps.lessonStore.refineSupersede({
            newId,
            watchId: input.watchId,
            category: oldLesson.category,
            oldLessonId: action.lessonId,
            newTitle: action.newTitle,
            newBody: action.newBody,
            rationale: action.rationale,
            promptVersion: input.feedbackPromptVersion,
            sourceFeedbackEventId: evt.id,
          });
          await deps.notifyLessonPending({
            lessonId: newId,
            watchId: input.watchId,
            category: oldLesson.category,
            title: action.newTitle,
            body: action.newBody,
            rationale: action.rationale,
            kind: "REFINE",
            before: { title: oldLesson.title, body: oldLesson.body },
            triggerSetupId: input.setupId,
            triggerCloseReason: input.closeReason,
          });
          changesApplied++;
          pendingApprovalsCreated++;
        } else if (action.type === "DEPRECATE") {
          await deps.lessonEventStore.append({
            watchId: input.watchId,
            lessonId: action.lessonId,
            type: "DEPRECATE",
            actor: input.feedbackPromptVersion,
            triggerSetupId: input.setupId,
            triggerCloseReason: input.closeReason,
            payload: { type: "DEPRECATE", data: { reason: action.reason } },
            provider: input.provider,
            model: input.model,
            promptVersion: input.feedbackPromptVersion,
            inputHash: input.inputHash,
          });
          await deps.lessonStore.updateStatus({
            lessonId: action.lessonId,
            fromStatus: "ACTIVE",
            toStatus: "DEPRECATED",
            occurredAt: new Date(),
          });
          changesApplied++;
        }
      }

      childLog.info(
        {
          proposed: input.proposedActions.length,
          applied: changesApplied,
          rejected: validation.rejected.length,
          pendingApprovals: pendingApprovalsCreated,
        },
        "applyLessonChanges complete",
      );

      return {
        changesApplied,
        pendingApprovalsCreated,
        costUsd: input.costUsd,
      };
    },
  };
}

/**
 * Best-effort reconstruction of `LessonAction[]` from previously persisted
 * lesson_events used on cache-hit replay. v1 returns an empty list — the
 * workflow only needs to know there was a hit; it doesn't re-apply actions
 * because the side effects already exist in the store.
 *
 * @deprecated v1 placeholder — always returns `[]`. The workflow uses the
 *   `cached: true` flag to short-circuit instead of replaying actions. Future
 *   phases may reconstruct actions from persisted payloads if needed.
 */
function cachedRunReplayActions(_events: { type: string; payload: unknown }[]): LessonAction[] {
  return [];
}
