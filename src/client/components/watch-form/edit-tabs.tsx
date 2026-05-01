import { Button } from "@client/components/ui/button";
import { cn } from "@client/lib/utils";
import * as React from "react";
import { useFormContext } from "react-hook-form";
import type { WizardStep } from "./wizard";

export function WatchEditTabs(props: {
  steps: WizardStep[];
  onSubmit: () => void;
  onReset?: () => void;
  isSubmitting?: boolean;
}) {
  const [activeId, setActiveId] = React.useState(props.steps[0]?.id ?? "");
  const form = useFormContext();
  const isDirty = form.formState.isDirty;

  const active = props.steps.find((s) => s.id === activeId) ?? props.steps[0];
  if (!active) return null;

  return (
    <div className="grid gap-6 md:grid-cols-[220px_1fr]">
      <nav className="flex flex-row md:flex-col gap-1 overflow-x-auto md:overflow-visible md:border-r md:pr-2">
        {props.steps.map((s) => {
          const isActive = s.id === active.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveId(s.id)}
              className={cn(
                "text-left whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                isActive ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground",
              )}
            >
              {s.title}
            </button>
          );
        })}
      </nav>

      <div className="space-y-6 min-w-0">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">{active.title}</h2>
          <p className="text-sm text-muted-foreground">{active.description}</p>
        </div>

        <div className="space-y-6">{active.render()}</div>

        <div className="flex items-center justify-end gap-2 border-t pt-6">
          {props.onReset ? (
            <Button
              type="button"
              variant="ghost"
              onClick={props.onReset}
              disabled={!isDirty || props.isSubmitting}
            >
              Annuler les modifications
            </Button>
          ) : null}
          <Button type="button" onClick={props.onSubmit} disabled={!isDirty || props.isSubmitting}>
            Enregistrer
          </Button>
        </div>
      </div>
    </div>
  );
}
