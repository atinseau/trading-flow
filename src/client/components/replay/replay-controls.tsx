import { Badge } from "@client/components/ui/badge";
import { Button } from "@client/components/ui/button";
import { Slider } from "@client/components/ui/slider";
import { Pause, Play, SkipForward, StepForward } from "lucide-react";

/**
 * Step controls for a replay session.
 *
 * Jalon 1 mode: `stepDisabled` is true. Buttons render with a badge
 * "Jalon 2 — Coming soon" and are not clickable. The scrubber however
 * IS active in Jalon 1 — it lets the user navigate visually through
 * events that were copied from the live baseline.
 */
export function ReplayControls(props: {
  windowStartAt: Date;
  windowEndAt: Date;
  playheadAt: Date;
  onScrub: (date: Date) => void;
  costUsdSoFar: number;
  costCapUsd: number;
  stepDisabled: boolean;
}) {
  const start = props.windowStartAt.getTime();
  const end = props.windowEndAt.getTime();
  const span = Math.max(1, end - start);
  const sliderValue = Math.round(((props.playheadAt.getTime() - start) / span) * 1000);

  function onSliderChange(value: number[]): void {
    const v = value[0] ?? 0;
    const t = start + (v / 1000) * span;
    props.onScrub(new Date(t));
  }

  return (
    <div className="rounded-md border bg-card p-3 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="outline" disabled={props.stepDisabled} title="Step 1 bougie">
          <StepForward className="size-3.5" />
          Step 1
        </Button>
        <Button size="sm" variant="outline" disabled={props.stepDisabled} title="Step 5 bougies">
          <SkipForward className="size-3.5" />
          Step 5
        </Button>
        <Button size="sm" variant="outline" disabled={props.stepDisabled} title="Auto-step">
          <Play className="size-3.5" />
          Auto
        </Button>
        <Button size="sm" variant="outline" disabled={props.stepDisabled}>
          <Pause className="size-3.5" />
          Pause
        </Button>
        {props.stepDisabled && (
          <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-300">
            Jalon 2 — Coming soon
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
        <Slider value={[sliderValue]} min={0} max={1000} step={1} onValueChange={onSliderChange} />
        <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
          <span>{props.windowStartAt.toLocaleString()}</span>
          <span>{props.playheadAt.toLocaleString()}</span>
          <span>{props.windowEndAt.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
