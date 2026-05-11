import { NotFoundError, requireParam, safeHandler, ValidationError } from "@client/api/safeHandler";
import type { Clock } from "@domain/ports/Clock";
import type { LiveEventQueryByWindow } from "@domain/ports/LiveEventQueryByWindow";
import type { LLMResponseCacheStore } from "@domain/ports/LLMResponseCacheStore";
import type { ReplayEventStore } from "@domain/ports/ReplayEventStore";
import type { ReplayLLMCallStore } from "@domain/ports/ReplayLLMCallStore";
import type { ListFilter, ReplaySessionRepository } from "@domain/ports/ReplaySessionRepository";
import type { WatchRepository } from "@domain/ports/WatchRepository";
import { copyLiveEventsToReplay } from "@domain/replay/copyLiveEvents";
import type { ReplaySessionStatus } from "@domain/replay/ReplaySession";
import {
  buildWorkflowId,
  DEFAULT_COST_CAP_USD,
  validateCreateSession,
} from "@domain/replay/replaySessionRules";
import { z } from "zod";

export type ReplayApiDeps = {
  sessionsRepo: ReplaySessionRepository;
  replayEventStore: ReplayEventStore;
  replayLlmCallStore: ReplayLLMCallStore;
  cacheStore: LLMResponseCacheStore;
  liveEventQuery: LiveEventQueryByWindow;
  watchRepo: WatchRepository;
  clock: Clock;
};

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

    /** DELETE /api/replay/sessions/:id (cascades to replay_events/llm_calls). */
    delete: safeHandler(async (_req, params) => {
      const id = requireParam(params, "id");
      const existing = await deps.sessionsRepo.get(id);
      if (!existing) throw new NotFoundError(`replay session ${id} not found`);
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

    // Task 4.5 (setups projection) and 4.6 (ohlcv) will be added next.
  };
}
