import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { cn } from "../../lib/utils";
import { Check } from "lucide-react";
import * as React from "react";
import { useFormContext } from "react-hook-form";

export type WizardStep = {
  id: string;
  title: string;
  description: string;
  /** Form field paths (RHF dot-paths) that should be valid before letting the
   * user advance. Empty = always valid (e.g. last review step). */
  fields: string[];
  render: () => React.ReactNode;
};

export function WatchFormWizard(props: {
  steps: WizardStep[];
  onSubmit: () => void;
  submitLabel: string;
  isSubmitting?: boolean;
}) {
  const [stepIdx, setStepIdx] = React.useState(0);
  const form = useFormContext();

  const step = props.steps[stepIdx]!;
  const isLast = stepIdx === props.steps.length - 1;
  const progress = ((stepIdx + 1) / props.steps.length) * 100;

  const goNext = async (): Promise<void> => {
    if (step.fields.length > 0) {
      const ok = await form.trigger(step.fields as never[]);
      if (!ok) return;
    }
    if (isLast) {
      props.onSubmit();
    } else {
      setStepIdx((i) => Math.min(i + 1, props.steps.length - 1));
    }
  };

  const goPrev = (): void => {
    setStepIdx((i) => Math.max(i - 1, 0));
  };

  return (
    <div className="space-y-8 max-w-2xl">
      {/* Step indicator */}
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            Étape <span className="font-semibold text-foreground">{stepIdx + 1}</span> sur{" "}
            {props.steps.length}
          </span>
          <span className="text-muted-foreground">{step.title}</span>
        </div>
        <Progress value={progress} className="h-1" />
        <ol className="flex items-center justify-between text-[11px] text-muted-foreground">
          {props.steps.map((s, i) => (
            <li
              key={s.id}
              className={cn(
                "flex items-center gap-1.5 transition-colors",
                i === stepIdx && "text-foreground font-medium",
                i < stepIdx && "text-foreground/70",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-[10px] font-mono",
                  i < stepIdx && "bg-primary text-primary-foreground border-primary",
                  i === stepIdx && "border-foreground text-foreground",
                  i > stepIdx && "border-border",
                )}
              >
                {i < stepIdx ? <Check className="size-3" /> : i + 1}
              </span>
              <span className="hidden sm:inline">{s.title}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Step header */}
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{step.title}</h2>
        <p className="text-sm text-muted-foreground">{step.description}</p>
      </div>

      {/* Step body */}
      <div className="space-y-6">{step.render()}</div>

      {/* Nav */}
      <div className="flex items-center justify-between border-t pt-6">
        <Button type="button" variant="ghost" onClick={goPrev} disabled={stepIdx === 0}>
          ← Précédent
        </Button>
        <Button type="button" onClick={goNext} disabled={props.isSubmitting}>
          {isLast ? props.submitLabel : "Suivant →"}
        </Button>
      </div>
    </div>
  );
}
