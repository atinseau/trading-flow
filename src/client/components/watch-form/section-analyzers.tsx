import { ComboInput, type ComboOption } from "../shared/combo-input";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import { useEffect } from "react";
import { useFormContext, useWatch } from "react-hook-form";

const PROVIDERS: ComboOption[] = [
  {
    value: "claude_max",
    label: "claude_max",
    hint: "Claude Agent SDK (compte Anthropic Max — modèles Anthropic uniquement)",
  },
  {
    value: "openrouter",
    label: "openrouter",
    hint: "OpenRouter — accès à 300+ modèles (n'importe quel ID accepté)",
  },
];

// Models exposed via the Claude Agent SDK. Only Anthropic models — free-text
// is still allowed (in case Anthropic ships a new model after this list was
// written), but the suggestions only include Anthropic IDs.
const CLAUDE_MAX_MODELS: ComboOption[] = [
  { value: "claude-opus-4-7", label: "claude-opus-4-7", hint: "Le plus capable — analyse profonde, plus cher" },
  { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6", hint: "Équilibre vitesse / qualité — défaut recommandé" },
  { value: "claude-haiku-4-5", label: "claude-haiku-4-5", hint: "Rapide et peu cher — bon pour le Reviewer" },
];

// OpenRouter has 300+ models. Show the popular ones; the field accepts any
// string so users can paste any OpenRouter model ID (e.g. "x-ai/grok-4").
const OPENROUTER_MODELS: ComboOption[] = [
  { value: "anthropic/claude-3.5-sonnet", label: "anthropic/claude-3.5-sonnet", hint: "Anthropic via OpenRouter" },
  { value: "anthropic/claude-3.5-haiku", label: "anthropic/claude-3.5-haiku", hint: "Anthropic via OpenRouter — rapide" },
  { value: "openai/gpt-4o", label: "openai/gpt-4o", hint: "OpenAI" },
  { value: "openai/gpt-4o-mini", label: "openai/gpt-4o-mini", hint: "OpenAI — rapide et économique" },
  { value: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro", hint: "Google" },
  { value: "google/gemini-2.5-flash", label: "google/gemini-2.5-flash", hint: "Google — rapide" },
  { value: "deepseek/deepseek-chat", label: "deepseek/deepseek-chat", hint: "DeepSeek — économique" },
  { value: "meta-llama/llama-3.3-70b-instruct", label: "meta-llama/llama-3.3-70b-instruct", hint: "Meta open-source" },
];

const ROLES: { key: "detector" | "reviewer" | "finalizer"; label: string; help: string }[] = [
  {
    key: "detector",
    label: "Détecteur",
    help:
      "Tourne à chaque tick. Analyse le graphique frais et propose / renforce des setups. C'est le plus fréquent — privilégie un modèle rapide et raisonnable en coût.",
  },
  {
    key: "reviewer",
    label: "Reviewer",
    help:
      "Affine les setups vivants en croisant les données fraîches avec la mémoire des analyses passées. Choix typique : modèle léger (Haiku) — il tourne souvent.",
  },
  {
    key: "finalizer",
    label: "Finalizer",
    help:
      "Tourne UNE fois par setup quand le score atteint le seuil. Décision GO/NO_GO finale. Choix typique : modèle premium (Opus) — peu fréquent, donc le coût absolu reste bas.",
  },
];

function modelsForProvider(provider: string | undefined): ComboOption[] {
  if (provider === "claude_max") return CLAUDE_MAX_MODELS;
  if (provider === "openrouter") return OPENROUTER_MODELS;
  return [];
}

function isModelKnownForProvider(provider: string | undefined, model: string): boolean {
  return modelsForProvider(provider).some((o) => o.value === model);
}

/**
 * Per-role row. Watches its own `provider` field and:
 *  - Switches the model suggestions (Claude SDK list ↔ OpenRouter list).
 *  - Resets the model when the provider changes AND the previously-selected
 *    model is incompatible with the new provider's catalog. This avoids
 *    "claude_max + openai/gpt-4o" combos that would fail at runtime.
 */
function AnalyzerRow({
  roleKey,
  label,
  help,
}: {
  roleKey: "detector" | "reviewer" | "finalizer";
  label: string;
  help: string;
}) {
  const f = useFormContext();
  const provider = useWatch({ control: f.control, name: `analyzers.${roleKey}.provider` }) as
    | string
    | undefined;
  const currentModel = useWatch({ control: f.control, name: `analyzers.${roleKey}.model` }) as
    | string
    | undefined;

  // When provider switches and the existing model is from another catalog,
  // wipe it. We tolerate free-text the user typed: only reset when the
  // value is recognized as belonging to the OTHER provider's known list.
  useEffect(() => {
    if (!provider || !currentModel) return;
    const knownInCurrent = isModelKnownForProvider(provider, currentModel);
    if (knownInCurrent) return;
    // Was it known in the other provider's list? Then it's a stale pick.
    const otherProvider = provider === "claude_max" ? "openrouter" : "claude_max";
    if (isModelKnownForProvider(otherProvider, currentModel)) {
      f.setValue(`analyzers.${roleKey}.model`, "", { shouldValidate: false, shouldDirty: true });
    }
    // If it's neither known here nor there, it's a custom/free-text value —
    // keep it. The user typed something on purpose.
  }, [provider, currentModel, roleKey, f]);

  const modelOptions = modelsForProvider(provider);
  const modelHint = (() => {
    if (provider === "claude_max")
      return "Modèles Anthropic uniquement (Claude Agent SDK).";
    if (provider === "openrouter")
      return "N'importe quel modèle OpenRouter (saisie libre acceptée).";
    return "Choisis d'abord un provider.";
  })();
  const modelEmpty = (() => {
    if (provider === "claude_max")
      return "Pas dans la liste — tape le nom exact du modèle Anthropic.";
    if (provider === "openrouter")
      return "Tape un model ID (ex: anthropic/claude-3.5-sonnet).";
    return "Choisis d'abord un provider";
  })();

  return (
    <div className="space-y-3 rounded-lg border bg-card/30 p-4">
      <div>
        <h4 className="text-sm font-semibold">{label}</h4>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{help}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField
          control={f.control}
          name={`analyzers.${roleKey}.provider`}
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Provider</FormLabel>
              <FormControl>
                <ComboInput
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  options={PROVIDERS}
                  placeholder="Choisir un provider…"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={f.control}
          name={`analyzers.${roleKey}.model`}
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Modèle</FormLabel>
              <FormControl>
                <ComboInput
                  key={provider ?? "no-provider"}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  options={modelOptions}
                  placeholder={modelOptions.length === 0 ? "Choisis un provider…" : "Choisir un modèle…"}
                  emptyHint={modelEmpty}
                />
              </FormControl>
              <FormDescription className="text-xs">{modelHint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}

export function SectionAnalyzers() {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
        <p className="font-medium">Comment fonctionne le pipeline en 3 étapes</p>
        <p className="text-muted-foreground">
          Chaque tick lance le <strong>Detector</strong>. Si un setup vit, le <strong>Reviewer</strong>{" "}
          le refine au tick suivant. Quand le score franchit le seuil, le <strong>Finalizer</strong>{" "}
          tranche en GO/NO_GO et envoie la notification.
        </p>
        <p className="text-muted-foreground">
          La liste de modèles s'adapte au provider choisi : <strong>claude_max</strong> n'expose que
          les modèles Anthropic ; <strong>openrouter</strong> accepte n'importe quel ID en saisie libre.
        </p>
      </div>

      {ROLES.map((r) => (
        <AnalyzerRow key={r.key} roleKey={r.key} label={r.label} help={r.help} />
      ))}
    </div>
  );
}
