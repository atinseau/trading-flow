import { AliveSetupsList } from "@client/components/replay/alive-setups-list";
import { CurrentPhaseCard } from "@client/components/replay/current-phase-card";
import { DecisionsLog } from "@client/components/replay/decisions-log";
import { derivePlayheadAt } from "@client/components/replay/derivePlayheadAt";
import { ReplayChart } from "@client/components/replay/replay-chart";
import { ReplayControls } from "@client/components/replay/replay-controls";
import type { ReplayEventRow, ReplaySessionStatus } from "@client/components/replay/replay-types";
import { SetupsTabs } from "@client/components/replay/setups-tabs";
import { ConfirmAction } from "@client/components/shared/confirm-action";
import { Badge } from "@client/components/ui/badge";
import { Button } from "@client/components/ui/button";
import { Skeleton } from "@client/components/ui/skeleton";
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
  const { session, events, setups, ohlcv, cost, step, pause, resume } = useReplaySteps(sessionId);

  const [activeSetupId, setActiveSetupId] = useState<string | null>(null);
  const [focusedEventId, setFocusedEventId] = useState<string | null>(null);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const [autoStepActive, setAutoStepActive] = useState(false);
  // Track the last tickAt we dispatched so the auto-step loop advances
  // even if the React Query invalidations haven't refetched yet.
  const lastDispatchedMsRef = useRef<number | null>(null);

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
  // when the user toggles off. Each iteration dispatches a single step
  // signal and relies on `step.isPending` to gate the next iteration so
  // we don't pile up signals faster than the worker drains them.
  // The 800ms delay is fast enough to feel automated, slow enough for
  // the human eye to follow the chart updating.
  useEffect(() => {
    if (!autoStepActive) return;
    if (!session.data || !ohlcv.data || !windowEndAt) return;
    if (step.isPending) return;
    const status = session.data.status;
    if (status === "COMPLETED" || status === "FAILED" || status === "COST_CAPPED") {
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
  }, [autoStepActive, session.data, ohlcv.data, windowEndAt, step.isPending, step.mutate, scrubMs]);

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
          <Badge variant="outline" className={cn("text-xs uppercase", STATUS_BADGE[s.status])}>
            {s.status}
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
        <ReplayChart
          candles={ohlcv.data.candles}
          events={events.data}
          setups={setups.data}
          windowStartAt={windowStartAt}
          windowEndAt={windowEndAt}
          playheadAt={playheadAt}
          activeSetupId={activeSetupId}
        />
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
        status={s.status}
        stepInFlight={step.isPending}
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
        onPause={() => {
          setAutoStepActive(false);
          pause.mutate();
        }}
        onResume={() => resume.mutate()}
        autoStepActive={autoStepActive}
        onToggleAuto={() => setAutoStepActive((v) => !v)}
      />

      {/* Two-column: left = chart already above; below: tabs/list + log */}
      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
        <div className="space-y-3">
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
        <div>
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            Phase courante
          </h3>
          <CurrentPhaseCard event={focusedEvent} sessionId={sessionId} />
        </div>
      </div>
    </div>
  );
}
