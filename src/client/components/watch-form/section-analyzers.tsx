import { ComboInput, type ComboOption } from "../shared/combo-input";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import { useFormContext } from "react-hook-form";

const PROVIDERS: ComboOption[] = [
  {
    value: "claude_max",
    label: "claude_max",
    hint: "Claude Agent SDK (compte Anthropic Max)",
  },
  {
    value: "openrouter",
    label: "openrouter",
    hint: "OpenRouter — accès à 300+ modèles",
  },
];

const MODELS: ComboOption[] = [
  // Claude
  { value: "claude-opus-4-7", label: "claude-opus-4-7", hint: "Claude — analyse profonde, plus cher" },
  { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6", hint: "Claude — équilibre vitesse/qualité" },
  { value: "claude-haiku-4-5", label: "claude-haiku-4-5", hint: "Claude — rapide, peu cher" },
  // OpenRouter (frequents — d'autres marchent aussi en saisie libre)
  { value: "anthropic/claude-3.5-sonnet", label: "anthropic/claude-3.5-sonnet", hint: "Via OpenRouter" },
  { value: "openai/gpt-4o", label: "openai/gpt-4o", hint: "Via OpenRouter" },
  { value: "openai/gpt-4o-mini", label: "openai/gpt-4o-mini", hint: "Via OpenRouter — rapide" },
  { value: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro", hint: "Via OpenRouter" },
  { value: "deepseek/deepseek-chat", label: "deepseek/deepseek-chat", hint: "Via OpenRouter — économique" },
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

export function SectionAnalyzers() {
  const f = useFormContext();
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
          Tu peux choisir un modèle dans la liste OU saisir n'importe quel nom de modèle (saisie
          libre acceptée — les choix proposés sont juste des raccourcis).
        </p>
      </div>

      {ROLES.map(({ key, label, help }) => (
        <div key={key} className="space-y-3 rounded-lg border bg-card/30 p-4">
          <div>
            <h4 className="text-sm font-semibold">{label}</h4>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{help}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField
              control={f.control}
              name={`analyzers.${key}.provider`}
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
              name={`analyzers.${key}.model`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Modèle</FormLabel>
                  <FormControl>
                    <ComboInput
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      options={MODELS}
                      placeholder="Choisir un modèle…"
                    />
                  </FormControl>
                  <FormDescription className="text-xs">
                    Doit exister chez le provider sélectionné. Saisie libre OK.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
