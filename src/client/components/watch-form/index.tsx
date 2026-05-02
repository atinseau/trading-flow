import { Form } from "@client/components/ui/form";
import { WatchEditTabs } from "@client/components/watch-form/edit-tabs";
import { SectionAdvanced } from "@client/components/watch-form/section-advanced";
import { SectionAnalyzers } from "@client/components/watch-form/section-analyzers";
import { SectionAsset } from "@client/components/watch-form/section-asset";
import { SectionIndicators } from "@client/components/watch-form/section-indicators";
import { SectionBudget } from "@client/components/watch-form/section-budget";
import { SectionLifecycle } from "@client/components/watch-form/section-lifecycle";
import { SectionNotifications } from "@client/components/watch-form/section-notifications";
import { SectionSchedule } from "@client/components/watch-form/section-schedule";
import { WatchFormWizard, type WizardStep } from "@client/components/watch-form/wizard";
import { type WatchConfig, WatchSchema } from "@domain/schemas/WatchesConfig";
import { zodResolver } from "@hookform/resolvers/zod";
import { type FieldErrors, type SubmitHandler, useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";

/** Walk a (possibly nested) FieldErrors tree and return the first message
 * with its dot-path (e.g. "asset.quoteType"). Used to surface validation
 * errors on hidden steps where no FormMessage can render.
 *
 * Path formatting matches what a developer would grep for:
 *   - numeric segments → "[0]" (RHF arrays)
 *   - "root" segments → omitted (RHF synthesizes these for array-level
 *     errors like `min(1)` and form-level `setError("root", ...)` calls) */
export function firstError(
  errors: FieldErrors,
  prefix = "",
): { path: string; message: string } | null {
  const join = (key: string): string => {
    if (!prefix) return key === "root" ? "(form)" : key;
    if (/^\d+$/.test(key)) return `${prefix}[${key}]`;
    if (key === "root") return prefix;
    return `${prefix}.${key}`;
  };
  for (const key of Object.keys(errors)) {
    const v = (errors as Record<string, unknown>)[key];
    if (!v || typeof v !== "object") continue;
    const path = join(key);
    const msg = (v as { message?: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) return { path, message: msg };
    const nested = firstError(v as FieldErrors, path);
    if (nested) return nested;
  }
  return null;
}

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
    min_risk_reward_ratio: 2,
  },
  optimization: {
    reviewer_skip_when_detector_corroborated: true,
    allow_same_tick_fast_path: true,
  },
  costs: { fees_pct: 0.1, slippage_pct: 0.05 },
  budget: { pause_on_budget_exceeded: true },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6", max_tokens: 2000 },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5", max_tokens: 2000 },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
    feedback: { provider: "claude_max", model: "claude-opus-4-7" },
  },
  notify_on: [
    "setup_created",
    "setup_strengthened",
    "setup_weakened",
    "setup_killed",
    "confirmed",
    "tp_hit",
    "sl_hit",
  ],
  include_chart_image: true,
  include_reasoning: true,
  feedback: {},
  pre_filter: {
    enabled: true,
    mode: "lenient" as const,
    thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 },
  },
  indicators: {},
};

/** Loose partial — caller passes whatever subset of the shape they have. */
export type WatchFormPreset = {
  id?: string;
  asset?: { symbol?: string; source?: string; quoteType?: string; exchange?: string };
  timeframes?: { primary?: string };
};

export type WatchFormProps = {
  initial?: WatchConfig;
  /** Optional partial pre-fill (e.g. from /assets/.../create-watch). Merged on top of SENSIBLE_DEFAULTS. */
  preset?: WatchFormPreset;
  mode: "create" | "edit";
  onSubmit: SubmitHandler<WatchConfig>;
};

const WIZARD_STEPS: WizardStep[] = [
  {
    id: "asset",
    title: "Actif",
    description:
      "Quel marché tu veux surveiller, et avec quelle granularité de temps. Le timeframe principal détermine la fréquence par défaut des analyses.",
    fields: ["id", "asset.symbol", "asset.source", "timeframes.primary"],
    render: () => <SectionAsset />,
  },
  {
    id: "indicators",
    title: "Indicateurs",
    description:
      "Choisis quels indicateurs techniques le bot utilise pour analyser cette watch. Aucun indicateur = analyse purement visuelle (mode naked).",
    fields: ["indicators"],
    render: () => <SectionIndicators />,
  },
  {
    id: "schedule",
    title: "Quand analyser",
    description:
      "À quelle fréquence le bot lance une nouvelle analyse. Si tu laisses le cron vide, il sera dérivé automatiquement du timeframe (ex: 1h → toutes les heures pile).",
    fields: ["schedule.detector_cron", "schedule.timezone"],
    render: () => <SectionSchedule />,
  },
  {
    id: "lifecycle",
    title: "Vie d'un setup",
    description:
      "Combien de temps un setup peut vivre avant d'expirer, et à partir de quel score de confiance il déclenche une notification.",
    fields: [
      "setup_lifecycle.ttl_candles",
      "setup_lifecycle.score_threshold_finalizer",
      "setup_lifecycle.invalidation_policy",
    ],
    render: () => <SectionLifecycle />,
  },
  {
    id: "analyzers",
    title: "Modèles d'IA",
    description:
      "Trois étapes (Detector → Reviewer → Finalizer). Tu peux mixer les providers et modèles pour optimiser coût vs qualité.",
    fields: [
      "analyzers.detector.provider",
      "analyzers.detector.model",
      "analyzers.reviewer.provider",
      "analyzers.reviewer.model",
      "analyzers.finalizer.provider",
      "analyzers.finalizer.model",
    ],
    render: () => <SectionAnalyzers />,
  },
  {
    id: "notify-budget",
    title: "Notifs & budget",
    description:
      "Quand recevoir un message Telegram, et combien tu acceptes de dépenser en LLM par jour avant que la watch se mette automatiquement en pause.",
    fields: ["notify_on"],
    render: () => (
      <div className="space-y-8">
        <SectionNotifications />
        <SectionBudget />
      </div>
    ),
  },
  {
    id: "advanced",
    title: "Réglages avancés",
    description:
      "Optionnel — ajuste le pré-filtre statistique, le score initial, et l'optimisation entre Detector et Reviewer. Les valeurs par défaut conviennent à la plupart des cas.",
    fields: [],
    render: () => <SectionAdvanced />,
  },
];

export function WatchForm({ initial, preset, mode, onSubmit }: WatchFormProps) {
  const merged = (() => {
    if (initial) return initial as unknown as WatchFormInput;
    if (!preset) return SENSIBLE_DEFAULTS as unknown as WatchFormInput;
    // Deep-merge SENSIBLE_DEFAULTS + preset (one level deep on object branches).
    return {
      ...SENSIBLE_DEFAULTS,
      ...preset,
      asset: { ...(SENSIBLE_DEFAULTS as { asset?: object }).asset, ...preset.asset },
      timeframes: {
        ...(SENSIBLE_DEFAULTS as { timeframes?: object }).timeframes,
        ...preset.timeframes,
      },
    } as unknown as WatchFormInput;
  })();

  const form = useForm<WatchFormInput, unknown, WatchConfig>({
    resolver: zodResolver(WatchSchema),
    defaultValues: merged,
    mode: "onBlur",
  });

  const onInvalid = (errors: FieldErrors): void => {
    const first = firstError(errors);
    toast.error(
      first ? `Champ invalide — ${first.path} : ${first.message}` : "Le formulaire contient des erreurs.",
    );
  };

  return (
    <Form {...form}>
      <form onSubmit={(e) => e.preventDefault()}>
        {mode === "create" ? (
          <WatchFormWizard
            steps={WIZARD_STEPS}
            onSubmit={() => form.handleSubmit(onSubmit, onInvalid)()}
            submitLabel="Créer la watch"
            isSubmitting={form.formState.isSubmitting}
          />
        ) : (
          <WatchEditTabs
            steps={WIZARD_STEPS}
            onSubmit={() => form.handleSubmit(onSubmit, onInvalid)()}
            onReset={() => form.reset(merged)}
            isSubmitting={form.formState.isSubmitting}
          />
        )}
      </form>
    </Form>
  );
}
