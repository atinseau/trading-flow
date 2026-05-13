import { NotFoundError, requireParam, safeHandler, ValidationError } from "@client/api/safeHandler";
import type { Clock } from "@domain/ports/Clock";
import type { LessonEventStore } from "@domain/ports/LessonEventStore";
import type { LessonStore } from "@domain/ports/LessonStore";
import type { LiveEventQueryByWindow } from "@domain/ports/LiveEventQueryByWindow";
import type { LLMResponseCacheStore } from "@domain/ports/LLMResponseCacheStore";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { ReplayEventStore } from "@domain/ports/ReplayEventStore";
import type { ReplayLLMCallStore } from "@domain/ports/ReplayLLMCallStore";
import type { ListFilter, ReplaySessionRepository } from "@domain/ports/ReplaySessionRepository";
import type { WatchRepository } from "@domain/ports/WatchRepository";
import { copyLiveEventsToReplay } from "@domain/replay/copyLiveEvents";
import { projectSetupsFromEvents } from "@domain/replay/projectSetups";
import type { ReplaySessionStatus } from "@domain/replay/ReplaySession";
import {
  buildWorkflowId,
  DEFAULT_COST_CAP_USD,
  type Timeframe,
  timeframeToMinutes,
  validateCreateSession,
} from "@domain/replay/replaySessionRules";
import type { ReplaySignalSender } from "@workflows/replay/replaySignals";
import { z } from "zod";

export type ReplayApiDeps = {
  sessionsRepo: ReplaySessionRepository;
  replayEventStore: ReplayEventStore;
  replayLlmCallStore: ReplayLLMCallStore;
  cacheStore: LLMResponseCacheStore;
  liveEventQuery: LiveEventQueryByWindow;
  watchRepo: WatchRepository;
  marketDataFetchers: Map<string, MarketDataFetcher>;
  clock: Clock;
  /**
   * Workflow signaller. Step/pause/resume endpoints dispatch through this
   * to wake the `replaySessionWorkflow` Temporal workflow. Defined as a
   * port so the API can be tested with a fake without spinning up a
   * Temporal server.
   */
  signaller: ReplaySignalSender;
  /**
   * Live lesson stores — used ONLY by the `promote` endpoint, which
   * materializes a `FeedbackLessonProposed` replay event into the prod
   * `lessons` / `lesson_events` tables. Every other endpoint stays
   * strictly isolated from these (invariant 1).
   */
  lessonStore: LessonStore;
  lessonEventStore: LessonEventStore;
};

const StepBodySchema = z
  .object({
    /** Single candle close (one-shot step). Mutually exclusive with `tickAts`. */
    tickAt: z.iso.datetime().optional(),
    /** Batch step : advance the playhead by N candles in one signal.
     *  Bounded to 50 to keep a malicious / accidental flood from spamming
     *  the worker (UI uses 1 or 5 in practice). */
    tickAts: z.array(z.iso.datetime()).min(1).max(50).optional(),
  })
  .refine((b) => Boolean(b.tickAt) !== Boolean(b.tickAts), {
    message: "must provide exactly one of `tickAt` or `tickAts`",
  });

const CreateBodySchema = z.object({
  watchId: z.string().min(1),
  name: z.string().optional().nullable(),
  windowStartAt: z.iso.datetime(),
  windowEndAt: z.iso.datetime(),
  costCapUsd: z.number().positive().optional(),
  lessonsMode: z.enum(["current", "historical", "disabled"]).optional(),
  feedbackMode: z.enum(["run", "skip"]).optional(),
});

const STATUS_VALUES: ReadonlyArray<ReplaySessionStatus> = [
  "READY",
  "PAUSED",
  "COMPLETED",
  "COST_CAPPED",
  "FAILED",
];

export function makeReplayApi(deps: ReplayApiDeps) {
  return {
    /** POST /api/replay/sessions — create a session, copy live baseline events. */
    create: safeHandler(async (req) => {
      const body = CreateBodySchema.parse(await req.json());
      const windowStartAt = new Date(body.windowStartAt);
      const windowEndAt = new Date(body.windowEndAt);

      const watch = await deps.watchRepo.findById(body.watchId);
      if (!watch) throw new NotFoundError(`watch ${body.watchId} not found`);

      const lessonsMode = body.lessonsMode ?? "current";
      const feedbackMode = body.feedbackMode ?? "run";
      const costCapUsd = body.costCapUsd ?? DEFAULT_COST_CAP_USD;

      const validation = validateCreateSession({
        watchId: body.watchId,
        watchConfig: watch,
        name: body.name ?? undefined,
        windowStartAt,
        windowEndAt,
        lessonsMode,
        feedbackMode,
        costCapUsd,
        now: deps.clock.now(),
      });
      if (!validation.ok) {
        throw new ValidationError(validation.reason);
      }

      const id = crypto.randomUUID();
      const session = await deps.sessionsRepo.create({
        id,
        watchId: body.watchId,
        name: body.name ?? null,
        status: "READY",
        windowStartAt,
        windowEndAt,
        workflowId: buildWorkflowId(id),
        configSnapshot: watch,
        lessonsMode,
        feedbackMode,
        costCapUsd,
      });

      // Jalon 1 baseline: copy live events that occurred within the window
      // into replay_events so the UI is immediately viewable. Jalon 2 will
      // additionally append new events when the user clicks Step.
      const { copied } = await copyLiveEventsToReplay(
        {
          liveEventQuery: deps.liveEventQuery,
          replayEventStore: deps.replayEventStore,
        },
        {
          sessionId: session.id,
          watchId: session.watchId,
          windowStartAt: session.windowStartAt,
          windowEndAt: session.windowEndAt,
        },
      );

      return Response.json({ session, baselineEventsCopied: copied }, { status: 201 });
    }),

    /** GET /api/replay/sessions?watchId=&status=&limit= */
    list: safeHandler(async (req) => {
      const url = new URL(req.url);
      const watchId = url.searchParams.get("watchId") ?? undefined;
      const statusParam = url.searchParams.get("status");
      const limitParam = url.searchParams.get("limit");

      let status: ReplaySessionStatus | undefined;
      if (statusParam) {
        if (!STATUS_VALUES.includes(statusParam as ReplaySessionStatus)) {
          throw new ValidationError(`invalid status: ${statusParam}`);
        }
        status = statusParam as ReplaySessionStatus;
      }

      const filter: ListFilter = { watchId, status };
      if (limitParam) {
        const n = Number.parseInt(limitParam, 10);
        if (!Number.isFinite(n) || n <= 0) throw new ValidationError("invalid limit");
        filter.limit = n;
      }

      const sessions = await deps.sessionsRepo.list(filter);
      return Response.json(sessions);
    }),

    /** GET /api/replay/sessions/:id */
    get: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const session = await deps.sessionsRepo.get(id);
      if (!session) throw new NotFoundError(`replay session ${id} not found`);
      return Response.json(session);
    }),

    /**
     * DELETE /api/replay/sessions/:id — cascades to replay_events /
     * replay_llm_calls via the FK ON DELETE CASCADE. Also asks the
     * signaller to terminate the underlying Temporal workflow so it
     * doesn't continue running as a zombie after the row is gone.
     *
     * Best-effort terminate : if the workflow doesn't exist (e.g. the
     * session was never stepped), we swallow the error rather than
     * fail the API call.
     */
    delete: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const existing = await deps.sessionsRepo.get(id);
      if (!existing) throw new NotFoundError(`replay session ${id} not found`);
      try {
        await deps.signaller.terminate({ sessionId: id, reason: "session_deleted" });
      } catch (_err) {
        // No workflow handle (never started) is the common case ; ignore.
      }
      await deps.sessionsRepo.delete(id);
      return new Response(null, { status: 204 });
    }),

    /** GET /api/replay/sessions/:id/events?sinceSeq= */
    events: safeHandler(async (req, params) => {
      const id = requireParam(params, "id");
      const url = new URL(req.url);
      const sinceSeqParam = url.searchParams.get("sinceSeq");
      const opts =
        sinceSeqParam !== null ? { sinceSeq: Number.parseInt(sinceSeqParam, 10) } : undefined;
      const session = await deps.sessionsRepo.get(id);
      if (!session) throw new NotFoundError(`replay session ${id} not found`);
      const events = await deps.replayEventStore.listBySession(id, opts);
      return Response.json(events);
    }),

    /** GET /api/replay/sessions/:id/cost-breakdown */
    costBreakdown: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const session = await deps.sessionsRepo.get(id);
      if (!session) throw new NotFoundError(`replay session ${id} not found`);
      const breakdown = await deps.replayLlmCallStore.costBreakdown(id);
      return Response.json({
        sessionId: id,
        costUsdSoFar: session.costUsdSoFar,
        costCapUsd: session.costCapUsd,
        byStage: breakdown,
      });
    }),

    /** GET /api/replay/sessions/:id/setups — event-sourced projection. */
    setupsProjection: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const session = await deps.sessionsRepo.get(id);
      if (!session) throw new NotFoundError(`replay session ${id} not found`);
      const events = await deps.replayEventStore.listBySession(id);
      const projection = projectSetupsFromEvents(events);
      return Response.json(projection);
    }),

    /** GET /api/replay/sessions/:id/llm-calls — raw LLM call audit list. */
    llmCalls: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const session = await deps.sessionsRepo.get(id);
      if (!session) throw new NotFoundError(`replay session ${id} not found`);
      // For the raw list we just return the cost breakdown rows; if more
      // detail is needed later, the store can be extended with a
      // listBySession() method.
      const breakdown = await deps.replayLlmCallStore.costBreakdown(id);
      return Response.json(breakdown);
    }),

    /**
     * POST /api/replay/sessions/:id/step
     *
     * Advances the playhead by one candle. The body's `tickAt` becomes the
     * next simulated tick. Uses `signalWithStart` under the hood, so the
     * first step also starts the workflow ; subsequent steps signal the
     * already-running workflow.
     *
     * Refuses to send when the session is in a terminal state — calling
     * step on a COMPLETED/FAILED session is a user error worth surfacing
     * instead of silently warming up a dead workflow.
     */
    step: safeHandler(async (req, params) => {
      const id = requireParam(params, "id");
      const session = await deps.sessionsRepo.get(id);
      if (!session) throw new NotFoundError(`replay session ${id} not found`);
      if (session.status === "COMPLETED" || session.status === "FAILED") {
        throw new ValidationError(`session is ${session.status}`);
      }
      const body = StepBodySchema.parse(await req.json());
      const tickAts = body.tickAts ?? (body.tickAt ? [body.tickAt] : []);

      const primary = session.configSnapshot.timeframes.primary as Timeframe;
      const tfMs = timeframeToMinutes(primary) * 60_000;
      // Validate every tickAt : window range + timeframe alignment. We
      // fail the whole batch on the first invalid tick so the user
      // doesn't silently lose ticks in the middle of a "Step N" click.
      for (const raw of tickAts) {
        const t = new Date(raw);
        if (t < session.windowStartAt || t > session.windowEndAt) {
          throw new ValidationError(
            `tickAt ${raw} outside session window [${session.windowStartAt.toISOString()}, ${session.windowEndAt.toISOString()}]`,
          );
        }
        const offsetMs = t.getTime() - session.windowStartAt.getTime();
        if (offsetMs % tfMs !== 0) {
          throw new ValidationError(
            `tickAt ${raw} not aligned on the ${primary} timeframe (offset from windowStartAt = ${offsetMs}ms, expected multiple of ${tfMs}ms)`,
          );
        }
      }

      await deps.signaller.step(
        body.tickAts
          ? { sessionId: id, tickAts: body.tickAts }
          : { sessionId: id, tickAt: body.tickAt },
      );
      return Response.json({ ok: true, tickAts });
    }),

    /** POST /api/replay/sessions/:id/pause — gate further tick processing. */
    pause: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const session = await deps.sessionsRepo.get(id);
      if (!session) throw new NotFoundError(`replay session ${id} not found`);
      if (session.status === "COMPLETED" || session.status === "FAILED") {
        throw new ValidationError(`session is ${session.status}`);
      }
      await deps.signaller.pause({ sessionId: id });
      return Response.json({ ok: true });
    }),

    /**
     * POST /api/replay/sessions/:id/terminate — clean exit + FAILED
     * status update. Used when the user wants to abort a session
     * without deleting its data (the events / cost breakdown remain
     * inspectable). The workflow's `terminateSignal` flips status to
     * FAILED and stops processing further tick signals.
     */
    terminate: safeHandler(async (req, params) => {
      const id = requireParam(params, "id");
      const session = await deps.sessionsRepo.get(id);
      if (!session) throw new NotFoundError(`replay session ${id} not found`);
      if (session.status === "COMPLETED" || session.status === "FAILED") {
        throw new ValidationError(`session is ${session.status}`);
      }
      const body = (await req.json().catch(() => ({}))) as { reason?: string };
      await deps.signaller.terminate({ sessionId: id, reason: body.reason });
      return Response.json({ ok: true });
    }),

    /** POST /api/replay/sessions/:id/resume — un-gate tick processing. */
    resume: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const session = await deps.sessionsRepo.get(id);
      if (!session) throw new NotFoundError(`replay session ${id} not found`);
      if (session.status === "COMPLETED" || session.status === "FAILED") {
        throw new ValidationError(`session is ${session.status}`);
      }
      await deps.signaller.resume({ sessionId: id });
      return Response.json({ ok: true });
    }),

    /** GET /api/replay/sessions/:id/ohlcv — OHLCV covering window + lookback. */
    ohlcv: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const session = await deps.sessionsRepo.get(id);
      if (!session) throw new NotFoundError(`replay session ${id} not found`);

      const watch = session.configSnapshot;
      const source = watch.asset.source;
      const fetcher = deps.marketDataFetchers.get(source);
      if (!fetcher) {
        throw new NotFoundError(`no MarketDataFetcher registered for source ${source}`);
      }

      // Render bougies covering both the lookback (so the bot's full
      // historical context is visible) and the window. detector_lookback
      // is in candles ; convert to ms via the primary timeframe.
      const primary = watch.timeframes.primary as Timeframe;
      const lookbackCandles = watch.candles?.detector_lookback ?? 200;
      const lookbackMs = lookbackCandles * timeframeToMinutes(primary) * 60_000;
      const from = new Date(session.windowStartAt.getTime() - lookbackMs);
      const to = session.windowEndAt;

      const candles = await fetcher.fetchRange({
        asset: watch.asset.symbol,
        timeframe: primary,
        from,
        to,
      });

      return Response.json({
        symbol: watch.asset.symbol,
        source,
        timeframe: primary,
        from: from.toISOString(),
        to: to.toISOString(),
        windowStartAt: session.windowStartAt.toISOString(),
        windowEndAt: session.windowEndAt.toISOString(),
        candles,
      });
    }),

    /**
     * POST /api/replay/sessions/:id/events/:eventId/promote
     *
     * Materializes a `FeedbackLessonProposed` replay event into the live
     * `lessons` / `lesson_events` tables. The user reviews the proposal
     * in the UI ; when they're convinced it's a real lesson, they click
     * "Promouvoir en prod" and this endpoint writes it to the live pool
     * with status=PENDING (the existing /api/lessons/:id/approve flow
     * then activates it).
     *
     * Idempotent : a second call for the same replay event returns 409
     * Conflict with the existing lessonId in the body. Detected via
     * `lesson_events.inputHash === "replay-promote:{eventId}"`.
     *
     * Discriminates by action :
     *  - CREATE → new lesson row + CREATE lesson_event
     *  - REINFORCE → incrementReinforced on the referenced lesson +
     *    REINFORCE lesson_event
     *  - REFINE → refineSupersede (new lesson row supersedes the old) +
     *    REFINE lesson_event
     *  - DEPRECATE → updateStatus(ACTIVE → DEPRECATED) + DEPRECATE
     *    lesson_event
     */
    promoteFeedbackLesson: safeHandler(async (_req, params) => {
      const sessionId = requireParam(params, "id");
      const eventId = requireParam(params, "eventId");
      const session = await deps.sessionsRepo.get(sessionId);
      if (!session) throw new NotFoundError(`replay session ${sessionId} not found`);

      const allEvents = await deps.replayEventStore.listBySession(sessionId);
      const evt = allEvents.find((e) => e.id === eventId);
      if (!evt) throw new NotFoundError(`replay event ${eventId} not found`);
      if (evt.type !== "FeedbackLessonProposed") {
        throw new ValidationError(`event ${eventId} is not a FeedbackLessonProposed`);
      }

      // Idempotence check : has this event already been promoted ?
      const inputHash = `replay-promote:${eventId}`;
      const prior = await deps.lessonEventStore.findByInputHash({
        watchId: session.watchId,
        inputHash,
      });
      if (prior.length > 0) {
        const first = prior[0];
        return Response.json(
          { ok: true, alreadyPromoted: true, lessonId: first?.lessonId ?? null },
          { status: 200 },
        );
      }

      const payload = evt.payload as { type: "FeedbackLessonProposed"; data: {
        action: "CREATE" | "REINFORCE" | "REFINE" | "DEPRECATE";
        category?: "detecting" | "reviewing" | "finalizing";
        title: string;
        body: string;
        rationale: string;
        sourceTradeSetupId: string;
        supersedesLessonId?: string;
      } };
      const data = payload.data;
      const triggerCloseReason = `promoted_from_replay:${sessionId}`;
      const actor = `replay-promote:${session.id.slice(0, 8)}`;
      const promotedVersion = `replay-promoted:${evt.promptVersion ?? "unknown"}`;

      if (data.action === "CREATE") {
        // The LLM-chosen category is propagated through the
        // FeedbackLessonProposed payload (`mapActionToProposedPayload`
        // now preserves it). Refuse to promote a CREATE that lacks a
        // category — that would force an arbitrary default and route the
        // lesson to the wrong stage. Replay events created before the
        // category was added are rejected here ; the user can re-run
        // the feedback analysis to produce a fresh proposal.
        if (!data.category) {
          throw new ValidationError(
            "CREATE proposal missing `category` (legacy replay event predating the category fix). Re-run the feedback analysis to generate a fresh proposal.",
          );
        }
        const newId = crypto.randomUUID();
        const lessonEvt = await deps.lessonEventStore.append({
          watchId: session.watchId,
          lessonId: newId,
          type: "CREATE",
          actor,
          triggerSetupId: data.sourceTradeSetupId,
          triggerCloseReason,
          payload: {
            type: "CREATE",
            data: {
              category: data.category,
              title: data.title,
              body: data.body,
              rationale: data.rationale,
            },
          },
          promptVersion: promotedVersion,
          inputHash,
        });
        await deps.lessonStore.create({
          id: newId,
          watchId: session.watchId,
          category: data.category,
          title: data.title,
          body: data.body,
          rationale: data.rationale,
          promptVersion: promotedVersion,
          sourceFeedbackEventId: lessonEvt.id,
          status: "PENDING",
        });
        return Response.json(
          { ok: true, lessonId: newId, action: "CREATE", category: data.category },
          { status: 201 },
        );
      }
      if (data.action === "REINFORCE") {
        if (!data.supersedesLessonId) {
          throw new ValidationError("REINFORCE payload missing supersedesLessonId");
        }
        await deps.lessonEventStore.append({
          watchId: session.watchId,
          lessonId: data.supersedesLessonId,
          type: "REINFORCE",
          actor,
          triggerSetupId: data.sourceTradeSetupId,
          triggerCloseReason,
          payload: { type: "REINFORCE", data: { reason: data.rationale } },
          promptVersion: promotedVersion,
          inputHash,
        });
        await deps.lessonStore.incrementReinforced(data.supersedesLessonId);
        return Response.json(
          { ok: true, lessonId: data.supersedesLessonId, action: "REINFORCE" },
          { status: 200 },
        );
      }
      if (data.action === "REFINE") {
        if (!data.supersedesLessonId) {
          throw new ValidationError("REFINE payload missing supersedesLessonId");
        }
        const oldLesson = await deps.lessonStore.getById(data.supersedesLessonId);
        if (!oldLesson) {
          throw new NotFoundError(`lesson ${data.supersedesLessonId} not found`);
        }
        const newId = crypto.randomUUID();
        const lessonEvt = await deps.lessonEventStore.append({
          watchId: session.watchId,
          lessonId: newId,
          type: "REFINE",
          actor,
          triggerSetupId: data.sourceTradeSetupId,
          triggerCloseReason,
          payload: {
            type: "REFINE",
            data: {
              supersedesLessonId: data.supersedesLessonId,
              before: { title: oldLesson.title, body: oldLesson.body },
              after: { title: data.title, body: data.body },
              rationale: data.rationale,
            },
          },
          promptVersion: promotedVersion,
          inputHash,
        });
        await deps.lessonStore.refineSupersede({
          newId,
          watchId: session.watchId,
          category: oldLesson.category,
          oldLessonId: data.supersedesLessonId,
          newTitle: data.title,
          newBody: data.body,
          rationale: data.rationale,
          promptVersion: promotedVersion,
          sourceFeedbackEventId: lessonEvt.id,
        });
        return Response.json({ ok: true, lessonId: newId, action: "REFINE" }, { status: 201 });
      }
      if (data.action === "DEPRECATE") {
        if (!data.supersedesLessonId) {
          throw new ValidationError("DEPRECATE payload missing supersedesLessonId");
        }
        await deps.lessonEventStore.append({
          watchId: session.watchId,
          lessonId: data.supersedesLessonId,
          type: "DEPRECATE",
          actor,
          triggerSetupId: data.sourceTradeSetupId,
          triggerCloseReason,
          payload: { type: "DEPRECATE", data: { reason: data.rationale } },
          promptVersion: promotedVersion,
          inputHash,
        });
        await deps.lessonStore.updateStatus({
          lessonId: data.supersedesLessonId,
          fromStatus: "ACTIVE",
          toStatus: "DEPRECATED",
          occurredAt: deps.clock.now(),
        });
        return Response.json(
          { ok: true, lessonId: data.supersedesLessonId, action: "DEPRECATE" },
          { status: 200 },
        );
      }
      throw new ValidationError(`unknown action: ${data.action}`);
    }),
  };
}
