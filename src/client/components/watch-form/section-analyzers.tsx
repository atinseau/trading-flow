import {
  FormControl, FormField, FormItem, FormLabel, FormMessage,
} from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { useFormContext } from "react-hook-form";

const ROLES = [
  { key: "detector", label: "Détecteur (analyse principale)" },
  { key: "reviewer", label: "Reviewer (raffinement)" },
  { key: "finalizer", label: "Finalizer (décision finale GO/NO_GO)" },
] as const;

export function SectionAnalyzers() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
        Modèles d'IA
      </h3>
      <p className="text-sm text-muted-foreground">
        Choisis quel provider et quel modèle utiliser pour chaque étape.
      </p>
      {ROLES.map(({ key, label }) => (
        <div key={key} className="space-y-2 border-l-2 border-border pl-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
          <FormField control={f.control} name={`analyzers.${key}.provider`} render={({ field }) => (
            <FormItem>
              <FormLabel>Provider</FormLabel>
              <FormControl><Input {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={f.control} name={`analyzers.${key}.model`} render={({ field }) => (
            <FormItem>
              <FormLabel>Modèle</FormLabel>
              <FormControl><Input {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>
      ))}
    </section>
  );
}
