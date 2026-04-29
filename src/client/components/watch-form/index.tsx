import { Button } from "@client/components/ui/button";
import { Form } from "@client/components/ui/form";
import { SectionAdvanced } from "@client/components/watch-form/section-advanced";
import { SectionAnalyzers } from "@client/components/watch-form/section-analyzers";
import { SectionAsset } from "@client/components/watch-form/section-asset";
import { SectionBudget } from "@client/components/watch-form/section-budget";
import { SectionLifecycle } from "@client/components/watch-form/section-lifecycle";
import { SectionNotifications } from "@client/components/watch-form/section-notifications";
import { SectionSchedule } from "@client/components/watch-form/section-schedule";
import { type WatchConfig, WatchSchema } from "@domain/schemas/WatchesConfig";
import { zodResolver } from "@hookform/resolvers/zod";
import { type SubmitHandler, useForm } from "react-hook-form";
import type { z } from "zod";

type WatchFormInput = z.input<typeof WatchSchema>;

const SENSIBLE_DEFAULTS = {
  enabled: true,
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50,
    score_initial: 25,
    score_threshold_finalizer: 80,
    score_threshold_dead: 10,
    invalidation_policy: "strict" as const,
    score_max: 100,
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6", max_tokens: 2000 },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5", max_tokens: 2000 },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
    feedback: { provider: "claude_max", model: "claude-opus-4-7" },
  },
  notify_on: ["confirmed", "tp_hit", "sl_hit"],
  include_chart_image: true,
  include_reasoning: true,
  feedback: {},
};

export type WatchFormProps = {
  initial?: WatchConfig;
  mode: "create" | "edit";
  onSubmit: SubmitHandler<WatchConfig>;
};

export function WatchForm({ initial, mode, onSubmit }: WatchFormProps) {
  const form = useForm<WatchFormInput, unknown, WatchConfig>({
    resolver: zodResolver(WatchSchema),
    defaultValues: (initial ?? SENSIBLE_DEFAULTS) as unknown as WatchFormInput,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8 max-w-2xl">
        <SectionAsset />
        <SectionSchedule />
        <SectionLifecycle />
        <SectionAnalyzers />
        <SectionNotifications />
        <SectionBudget />
        <SectionAdvanced />
        <div className="flex gap-2 pt-4">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {mode === "create" ? "Créer la watch" : "Enregistrer"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
