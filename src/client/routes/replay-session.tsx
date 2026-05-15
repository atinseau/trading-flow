import { AliveSetupsList } from "@client/components/replay/alive-setups-list";
import { buildScrubBatch, estimateScrubCost } from "@client/components/replay/buildScrubBatch";
import { CurrentPhaseCard } from "@client/components/replay/current-phase-card";
import { DecisionsLog } from "@client/components/replay/decisions-log";
import { derivePlayheadAt } from "@client/components/replay/derivePlayheadAt";
import { IndicatorToggles } from "@client/components/replay/indicator-toggles";
import { pickLiveStatus } from "@client/components/replay/pickLiveStatus";
import { ReplayChart } from "@client/components/replay/replay-chart";
import { ReplayControls } from "@client/components/replay/replay-controls";
import type { ReplayEventRow, ReplaySessionStatus } from "@client/components/replay/replay-types";
import { ScrubConfirmDialog } from "@client/components/replay/scrub-confirm-dialog";
import { SetupsTabs } from "@client/components/replay/setups-tabs";
import { ConfirmAction } from "@client/components/shared/confirm-action";
import { Badge } from "@client/components/ui/badge";
import { Button } from "@client/components/ui/button";
import { Skeleton } from "@client/components/ui/skeleton";
import { usePostBusyInvalidation } from "@client/hooks/usePostBusyInvalidation";
import { useReplaySteps } from "@client/hooks/useReplaySteps";
import { api } from "@client/lib/api";
import { timeframeToMinutes } from "@client/lib/timeframe";
import { cn } from "@client/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

const STATUS_BADGE: Record<ReplaySessionStatus, string> = {
  READY: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  PAUSED: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  COMPLETED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  COST_CAPPED: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  FAILED: "bg-red-500/15 text-red-300 border-red-500/30",
};

function lastEventBefore(
  events: ReplayEventRow[],
  playheadMs: number,
  activeSetupId: string | null,
): ReplayEventRow | null {
  const scoped = activeSetupId ? events.filter((e) => e.setupId === activeSetupId) : events;
  for (let i = scoped.length - 1; i >= 0; i--) {
    const e = scoped[i];
    if (e && new Date(e.occurredAt).getTime() <= playheadMs) return e;
  }
  return null;
}

export function Component() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    session,
    events,
    setups,
    ohlcv,
    cost,
    workflowState,
    step,
    pause,
    resume,
    invalidateAll,
  } = useReplaySteps(sessionId);

  // Workflow tick just finished — pull events / setups / cost / session
  // fresh so the UI doesn't have to wait up to 8s for the slow idle poll.
  // The hook fires exactly once per busy→idle edge.
  usePostBusyInvalidation(workflowState.data?.live?.tickInProgress, () => {
    void invalidateAll();
  });

  const [activeSetupId, setActiveSetupId] = useState<string | null>(null);
  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const [autoStepActive, setAutoStepActive] = useState(false);
  // Indicator-visibility filter for the chart overlay. Defaults to "all
  // enabled in the watch config". The user can toggle individual ids
  // without touching the watch.
  const [hiddenIndicatorIds, setHiddenIndicatorIds] = useState<Set<string>>(new Set());
  // Scrub-confirm modal state — populated on slider release when the
  // target is forward of the bot. Cancel resets the scrub to null
  // (visual playhead snaps back to the bot). Confirm dispatches the
  // batch via `step.mutate({ tickAts })`.
  const [scrubModal, setScrubModal] = useState<{
    botAt: Date;
    targetAt: Date;
    tickAts: string[];
    tickCount: number;
    estimatedCostUsd: number;
    truncatedToMax: boolean;
  } | null>(null);
  // Track the last tickAt we dispatched so the auto-step loop advances
  // even if the React Query invalidations haven't refetched yet.
  const lastDispatchedMsRef = useRef<number | null>(null);
  // True while a scrub-confirm is being processed — guards against Radix's
  // AlertDialog calling our `onOpenChange(false)` *after* `onConfirm` runs
  // (DialogPrimitive.Close composes onClick + onOpenChange in that order).
  // Without the flag, the cancel-side reset of `scrubMs` would overwrite
  // the confirm-side `scrubMs = targetAt`.
  const scrubConfirmingRef = useRef(false);

  const windowStartAt = session.data ? new Date(session.data.windowStartAt) : null;
  const windowEndAt = session.data ? new Date(session.data.windowEndAt) : null;
  // Playhead derivation lives in a pure helper so it's directly unit-testable
  // and can't silently regress to "windowEndAt by default" (the original bug
  // that froze the session at COMPLETED after a single Step).
  const playheadAt = useMemo(() => {
    if (!windowStartAt || !windowEndAt) return null;
    return derivePlayheadAt({
      windowStartAt,
      windowEndAt,
      events: events.data ?? [],
      scrubMs,
    });
  }, [windowStartAt, windowEndAt, events.data, scrubMs]);

  const focusedEvent = useMemo(() => {
    if (!events.data || !playheadAt) return null;
    if (focusedEventId) {
      return events.data.find((e) => e.id === focusedEventId) ?? null;
    }
    return lastEventBefore(events.data, playheadAt.getTime(), activeSetupId);
  }, [events.data, focusedEventId, playheadAt, activeSetupId]);

  // Auto-step loop : while active, fire one step per AUTO_STEP_DELAY_MS.
  // The loop self-stops on terminal status, cost cap, end-of-window, or
  // when the user toggles off. We gate on three signals so we never pile
  // signals faster than the worker drains them:
  //   - `step.isPending`  : an HTTP /step POST is mid-flight
  //   - `tickInProgress`  : the workflow is inside processTick
  //   - `pendingTicks>0`  : the workflow already has queued ticks
  // The 800ms delay is fast enough to feel automated, slow enough for
  // the human eye to follow the chart updating.
  const live = workflowState.data?.live;
  const workflowBusyForAuto = (live?.tickInProgress ?? false) || (live?.pendingTicks ?? 0) > 0;
  // Prefer the live workflow status when available — the DB row lags
  // behind pause/resume signals (see pickLiveStatus docblock).
  const effectiveStatus = session.data
    ? pickLiveStatus(session.data.status, live?.status)
    : ("READY" as ReplaySessionStatus);
  useEffect(() => {
    if (!autoStepActive) return;
    if (!session.data || !ohlcv.data || !windowEndAt) return;
    if (step.isPending) return;
    if (workflowBusyForAuto) return;
    if (
      effectiveStatus === "COMPLETED" ||
      effectiveStatus === "FAILED" ||
      effectiveStatus === "COST_CAPPED"
    ) {
      setAutoStepActive(false);
      return;
    }
    // Don't auto-dispatch into a PAUSED workflow — the user explicitly
    // gated processing; tick the loop only when the workflow accepts work.
    if (effectiveStatus === "PAUSED") {
      setAutoStepActive(false);
      return;
    }
    const tfMs = timeframeToMinutes(ohlcv.data.timeframe) * 60_000;
    const baseMs =
      lastDispatchedMsRef.current ??
      (scrubMs !== null ? scrubMs : new Date(session.data.windowStartAt).getTime());
    const nextMs = Math.min(baseMs + tfMs, windowEndAt.getTime());
    if (nextMs <= baseMs) {
      // We're already at the end — exit auto.
      setAutoStepActive(false);
      return;
    }
    const handle = window.setTimeout(() => {
      const next = new Date(nextMs);
      step.mutate({ tickAt: next.toISOString() });
      lastDispatchedMsRef.current = nextMs;
      setScrubMs(nextMs);
      setFocusedEventId(null);
    }, 800);
    return () => window.clearTimeout(handle);
  }, [
    autoStepActive,
    session.data,
    ohlcv.data,
    windowEndAt,
    step.isPending,
    step.mutate,
    scrubMs,
    workflowBusyForAuto,
    effectiveStatus,
  ]);

  const del = useMutation({
    mutationFn: () => api(`/api/replay/sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["replay", "list"] });
      navigate("/replay");
    },
  });

  if (session.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[380px]" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (session.error || !session.data) {
    return (
      <div className="space-y-3">
        <Link to="/replay" className="text-xs text-muted-foreground hover:text-foreground">
          ← Replay
        </Link>
        <div className="text-sm text-destructive">
          Session introuvable ou erreur : {session.error ? (session.error as Error).message : "404"}
        </div>
      </div>
    );
  }

  const s = session.data;
  if (!windowStartAt || !windowEndAt || !playheadAt) return null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="space-y-2">
        <Link
          to="/replay"
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ArrowLeft className="size-3" />
          Replay
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold">{s.name ?? `Session ${s.id.slice(0, 8)}`}</h1>
          <Badge
            variant="outline"
            className={cn("text-xs uppercase", STATUS_BADGE[effectiveStatus])}
          >
            {effectiveStatus}
          </Badge>
          <span className="text-xs text-muted-foreground font-mono">
            {s.watchId} · lessons={s.lessonsMode} · feedback={s.feedbackMode}
          </span>
          <div className="ml-auto">
            <ConfirmAction
              title={`Supprimer cette session ?`}
              description="Tous les events de la session seront supprimés. Le cache LLM mutualisé est préservé."
              trigger={
                <Button size="sm" variant="destructive">
                  <Trash2 className="size-3.5" />
                  Supprimer
                </Button>
              }
              onConfirm={() => del.mutate()}
              destructive
            />
          </div>
        </div>
      </div>

      {/* Chart */}
      {ohlcv.isLoading && <Skeleton className="h-[380px]" />}
      {ohlcv.error && (
        <div className="text-sm text-destructive">
          Erreur OHLCV : {(ohlcv.error as Error).message}
        </div>
      )}
      {ohlcv.data && events.data && setups.data && (
        <>
          {ohlcv.data.indicators && Object.keys(ohlcv.data.indicators).length > 0 && (
            <IndicatorToggles
              availableIds={Object.keys(ohlcv.data.indicators)}
              visible={
                new Set(
                  Object.keys(ohlcv.data.indicators).filter((id) => !hiddenIndicatorIds.has(id)),
                )
              }
              onToggle={(id) => {
                setHiddenIndicatorIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                });
              }}
            />
          )}
          <ReplayChart
            candles={ohlcv.data.candles}
            events={events.data}
            setups={setups.data}
            windowStartAt={windowStartAt}
            windowEndAt={windowEndAt}
            playheadAt={playheadAt}
            activeSetupId={activeSetupId}
            indicators={ohlcv.data.indicators}
            indicatorMeta={ohlcv.data.indicatorMeta}
            visibleIndicators={
              ohlcv.data.indicators
                ? new Set(
                    Object.keys(ohlcv.data.indicators).filter((id) => !hiddenIndicatorIds.has(id)),
                  )
                : null
            }
          />
        </>
      )}

      {/* Controls */}
      <ReplayControls
        timeframe={ohlcv.data?.timeframe ?? "1h"}
        windowStartAt={windowStartAt}
        windowEndAt={windowEndAt}
        playheadAt={playheadAt}
        onScrub={(d) => {
          setScrubMs(d.getTime());
          setFocusedEventId(null);
        }}
        costUsdSoFar={cost.data?.costUsdSoFar ?? s.costUsdSoFar}
        costCapUsd={cost.data?.costCapUsd ?? s.costCapUsd}
        status={effectiveStatus}
        stepInFlight={step.isPending}
        workflowBusy={workflowState.data?.live?.tickInProgress ?? false}
        pendingTicks={workflowState.data?.live?.pendingTicks ?? 0}
        onStep={(tickAts) => {
          if (tickAts.length === 0) return;
          const isoList = tickAts.map((t) => t.toISOString());
          step.mutate(
            isoList.length === 1 ? { tickAt: isoList[0] as string } : { tickAts: isoList },
          );
          // Snap the playhead forward to the LAST tick of the batch so the
          // chart immediately reflects where the workflow is heading ;
          // events will land asynchronously.
          const last = tickAts[tickAts.length - 1];
          if (last) {
            setScrubMs(last.getTime());
            lastDispatchedMsRef.current = last.getTime();
          }
          setFocusedEventId(null);
        }}
        onScrubCommit={(targetDate) => {
          // Ignore commits while the workflow is busy / capped / terminal —
          // we shouldn't open a "send N ticks" modal when dispatch would
          // either pile up signals or be rejected.
          if (step.isPending || workflowBusyForAuto) return;
          if (
            effectiveStatus === "COMPLETED" ||
            effectiveStatus === "FAILED" ||
            effectiveStatus === "COST_CAPPED" ||
            effectiveStatus === "PAUSED"
          ) {
            return;
          }
          if (!ohlcv.data) return;
          // Bot position = last tickAt the workflow has actually processed,
          // falling back to the window start when the session is fresh.
          const botAtMs =
            live?.lastTickAt != null
              ? new Date(live.lastTickAt).getTime()
              : new Date(s.windowStartAt).getTime();
          const tfMs = timeframeToMinutes(ohlcv.data.timeframe) * 60_000;
          const batch = buildScrubBatch({
            botAtMs,
            targetAtMs: targetDate.getTime(),
            timeframeMs: tfMs,
            windowEndMs: new Date(s.windowEndAt).getTime(),
          });
          if (batch.tickCount === 0) return; // backward drag or same → no modal
          // Cost averages from the session's actual breakdown.
          const detStage = cost.data?.byStage.find((b) => b.stage === "detector");
          const revStage = cost.data?.byStage.find((b) => b.stage === "reviewer");
          const detectorAvg =
            detStage && detStage.calls > 0 ? detStage.totalCostUsd / detStage.calls : null;
          const reviewerAvg =
            revStage && revStage.calls > 0 ? revStage.totalCostUsd / revStage.calls : null;
          const ticksProcessed = (events.data ?? []).filter(
            (e) => e.type === "DetectorTickProcessed",
          ).length;
          const estimatedCostUsd = estimateScrubCost({
            costUsdSoFar: cost.data?.costUsdSoFar ?? s.costUsdSoFar,
            ticksProcessed,
            aliveSetupsCount: live?.aliveSetups.length ?? 0,
            detectorAvgUsdPerCall: detectorAvg,
            reviewerAvgUsdPerCall: reviewerAvg,
            tickCount: batch.tickCount,
          });
          setScrubModal({
            botAt: new Date(botAtMs),
            targetAt: batch.effectiveTargetAt,
            tickAts: batch.tickAts,
            tickCount: batch.tickCount,
            estimatedCostUsd,
            truncatedToMax: batch.truncatedToMax,
          });
        }}
        onPause={() => {
          setAutoStepActive(false);
          pause.mutate();
        }}
        onResume={() => resume.mutate()}
        autoStepActive={autoStepActive}
        onToggleAuto={() => setAutoStepActive((v) => !v)}
      />
      <ScrubConfirmDialog
        open={scrubModal !== null}
        onOpenChange={(open) => {
          if (open) return;
          if (scrubConfirmingRef.current) {
            // This close was fired by AlertDialog's internal Close composition
            // immediately after our onConfirm. Skip the cancel-side reset so
            // the forward scrubMs we just set survives.
            scrubConfirmingRef.current = false;
            return;
          }
          // Cancel button / Esc / backdrop — bring the visual playhead back
          // to the bot (clearing scrubMs makes derivePlayheadAt return the
          // bot's last event).
          setScrubModal(null);
          setScrubMs(null);
        }}
        botAt={scrubModal?.botAt ?? new Date()}
        targetAt={scrubModal?.targetAt ?? new Date()}
        tickCount={scrubModal?.tickCount ?? 0}
        estimatedCostUsd={scrubModal?.estimatedCostUsd ?? 0}
        truncatedToMax={scrubModal?.truncatedToMax ?? false}
        onConfirm={() => {
          if (!scrubModal) return;
          scrubConfirmingRef.current = true;
          const { tickAts, targetAt } = scrubModal;
          step.mutate(tickAts.length === 1 ? { tickAt: tickAts[0] as string } : { tickAts });
          // Snap the playhead to the batch's effective end so the chart
          // visually leads the workflow ; events land async.
          setScrubMs(targetAt.getTime());
          lastDispatchedMsRef.current = targetAt.getTime();
          setFocusedEventId(null);
          setScrubModal(null);
        }}
      />

      {/* Two-column: left = chart already above; below: tabs/list + log.
          `min-w-0` on both grid items is critical: CSS grid items default to
          `min-width: auto` (i.e. as wide as their content), which makes the
          left column blow up to fit the longest event reasoning string —
          overflowing the page and starving the right column. With min-w-0
          the columns honor the 3fr/2fr ratio and `truncate` works. */}
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
        <div className="space-y-3 min-w-0">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            Setups dans la session ({setups.data?.length ?? 0})
          </h3>
          <AliveSetupsList
            setups={setups.data ?? []}
            activeSetupId={activeSetupId}
            onPick={(id) => {
              setActiveSetupId(id);
              setFocusedEventId(null);
            }}
          />
          {setups.data && setups.data.length > 0 && (
            <SetupsTabs
              setups={setups.data}
              activeSetupId={activeSetupId}
              onChange={(id) => {
                setActiveSetupId(id);
                setFocusedEventId(null);
              }}
            />
          )}
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mt-4">
            Decisions log ({events.data?.length ?? 0} events)
          </h3>
          <DecisionsLog
            events={events.data ?? []}
            activeSetupId={activeSetupId}
            focusedEventId={focusedEventId}
            onFocus={setFocusedEventId}
          />
        </div>
        <div className="min-w-0">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Phase courante
          </h3>
          <CurrentPhaseCard event={focusedEvent} sessionId={sessionId} />
        </div>
      </div>
    </div>
  );
}
