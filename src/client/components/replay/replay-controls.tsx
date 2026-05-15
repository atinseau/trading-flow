import { Badge } from "@client/components/ui/badge";
import { Button } from "@client/components/ui/button";
import { Slider } from "@client/components/ui/slider";
import { fmtParisShort } from "@client/lib/format";
import { timeframeToMinutes } from "@client/lib/timeframe";
import { Loader2, Pause, Play, SkipForward, Square, StepForward } from "lucide-react";
import { computeStepGating } from "./replayStepGating";

/**
 * Step controls for a replay session.
 *
 * Step 1 / Step 5 dispatch one (or five sequential) step signals, each
 * advancing the playhead by one candle of the session's primary
 * timeframe. The workflow processes them serially.
 *
 * Pause and Resume signal the workflow to gate further tick processing.
 * They are session-status aware (disabled in terminal states) AND
 * workflow-aware (disabled while a tick is being processed or queued —
 * dispatching another step on top would just pile up signals while the
 * user thinks "nothing is happening").
 */
export function ReplayControls(props: {
  timeframe: string;
  windowStartAt: Date;
  windowEndAt: Date;
  playheadAt: Date;
  onScrub: (date: Date) => void;
  costUsdSoFar: number;
  costCapUsd: number;
  status: "READY" | "PAUSED" | "COMPLETED" | "COST_CAPPED" | "FAILED";
  /** Mutation in flight (HTTP roundtrip to /step). */
  stepInFlight: boolean;
  /** True iff the Temporal workflow is currently inside `processTick` —
   *  the Detector / Reviewer / Finalizer chain is running and would
   *  ignore a fresh tick anyway. UI uses this to grey Step + render the
   *  spinner badge. */
  workflowBusy: boolean;
  /** Number of ticks already queued in the workflow but not yet drained.
   *  We surface this so the user understands why Step is greyed even
   *  when a tick isn't actively running (it's about to run). */
  pendingTicks: number;
  /** Dispatch one or N ticks. The component decides the batch size ; the
   *  parent forwards the array to the /step endpoint in a single signal. */
  onStep: (tickAts: Date[]) => void;
  /**
   * Fired once when the user releases the scrubber (pointer up / touch end /
   * arrow key release). The parent decides whether to open the confirm
   * dialog based on `targetDate` vs the bot's actual position — the
   * controls component intentionally stays unaware of that workflow.
   */
  onScrubCommit?: (targetDate: Date) => void;
  onPause: () => void;
  onResume: () => void;
  /** Auto-step toggle. The parent owns the loop : it dispatches one step
   *  per tick interval until cancelled or a terminal state is reached. */
  autoStepActive: boolean;
  onToggleAuto: () => void;
}) {
  const start = props.windowStartAt.getTime();
  const end = props.windowEndAt.getTime();
  const span = Math.max(1, end - start);
  const sliderValue = Math.round(((props.playheadAt.getTime() - start) / span) * 1000);

  const tfMs = timeframeToMinutes(props.timeframe) * 60_000;
  const terminal = props.status === "COMPLETED" || props.status === "FAILED";
  const capped = props.status === "COST_CAPPED";
  // Gating logic lives in `replayStepGating.ts` (pure, unit-tested) so the
  // four-axis truth table can't silently regress through CSS / JSX edits.
  const gate = computeStepGating({
    status: props.status,
    stepInFlight: props.stepInFlight,
    workflowBusy: props.workflowBusy,
    pendingTicks: props.pendingTicks,
  });
  const { stepDisabled, autoDisabled, showBusyBadge, workflowActivelyProcessing } = gate;
  const busy = showBusyBadge;
  // Tooltip wording must distinguish the two busy states so the user knows
  // whether to wait (workflow inside processTick, LLM latency) or whether
  // their previous clicks are still draining (queue depth).
  const busyTooltip = workflowActivelyProcessing
    ? "Raisonnement en cours — attends la fin du tick"
    : `${props.pendingTicks} tick(s) en file — patiente`;

  function buildBatch(n: number): Date[] {
    const batch: Date[] = [];
    let next = props.playheadAt.getTime();
    for (let i = 0; i < n; i++) {
      next = Math.min(next + tfMs, end);
      batch.push(new Date(next));
      if (next >= end) break;
    }
    return batch;
  }

  return (
    <div className="rounded-md border bg-card p-3 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          disabled={stepDisabled}
          title={busy ? busyTooltip : "Step 1 bougie"}
          onClick={() => props.onStep(buildBatch(1))}
        >
          {props.stepInFlight || busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <StepForward className="size-3.5" />
          )}
          Step 1
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={stepDisabled}
          title={busy ? busyTooltip : "Step 5 bougies (batché en un signal)"}
          onClick={() => props.onStep(buildBatch(5))}
        >
          <SkipForward className="size-3.5" />
          Step 5
        </Button>
        <Button
          size="sm"
          variant={props.autoStepActive ? "default" : "outline"}
          disabled={autoDisabled}
          title={
            props.autoStepActive
              ? "Stopper l'auto-step"
              : busy
                ? busyTooltip
                : "Auto-step : avance d'une bougie toutes les ~800ms"
          }
          onClick={props.onToggleAuto}
        >
          {props.autoStepActive ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
          {props.autoStepActive ? "Stop auto" : "Auto"}
        </Button>
        {props.status === "PAUSED" ? (
          <Button size="sm" variant="outline" disabled={terminal} onClick={props.onResume}>
            <Play className="size-3.5" />
            Reprendre
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={terminal || capped || props.status !== "READY" || props.autoStepActive}
            onClick={props.onPause}
          >
            <Pause className="size-3.5" />
            Pause
          </Button>
        )}
        {capped && (
          <Badge variant="outline" className="text-[10px] border-orange-500/40 text-orange-300">
            Cost cap atteint
          </Badge>
        )}
        {terminal && (
          <Badge
            variant="outline"
            className="text-[10px] border-muted-foreground/40 text-muted-foreground"
          >
            {props.status}
          </Badge>
        )}
        {showBusyBadge && (
          <Badge
            variant="outline"
            className="text-[10px] border-blue-500/40 text-blue-300 gap-1"
            title={
              workflowActivelyProcessing
                ? "Le workflow exécute actuellement Detector / Reviewer / Finalizer."
                : `${props.pendingTicks} tick(s) en attente — le worker draine.`
            }
          >
            <Loader2 className="size-3 animate-spin" />
            {workflowActivelyProcessing
              ? "Raisonnement en cours…"
              : `${props.pendingTicks} tick(s) en file`}
          </Badge>
        )}
        <div className="ml-auto text-xs text-muted-foreground font-mono">
          ${props.costUsdSoFar.toFixed(2)} / ${props.costCapUsd.toFixed(2)}
        </div>
      </div>
      <div className="space-y-1">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
          Scrubber — playhead
        </div>
        <Slider
          value={[sliderValue]}
          min={0}
          max={1000}
          step={1}
          onValueChange={(value: number[]) => {
            const v = value[0] ?? 0;
            props.onScrub(new Date(start + (v / 1000) * span));
          }}
          onValueCommit={(value: number[]) => {
            if (!props.onScrubCommit) return;
            const v = value[0] ?? 0;
            props.onScrubCommit(new Date(start + (v / 1000) * span));
          }}
        />
        <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
          <span>{fmtParisShort(props.windowStartAt)}</span>
          <span>{fmtParisShort(props.playheadAt)}</span>
          <span>{fmtParisShort(props.windowEndAt)}</span>
        </div>
      </div>
    </div>
  );
}
