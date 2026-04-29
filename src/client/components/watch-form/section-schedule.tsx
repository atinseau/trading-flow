import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { useFormContext } from "react-hook-form";

export function SectionSchedule() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
        Quand analyser
      </h3>
      <FormField
        control={f.control}
        name="schedule.detector_cron"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Fréquence d'analyse (cron) — optionnel</FormLabel>
            <FormControl>
              <Input placeholder="*/15 * * * *" {...field} value={field.value ?? ""} />
            </FormControl>
            <FormDescription>
              Si vide, dérivé automatiquement du timeframe (ex: 1h → "0 * * * *").
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={f.control}
        name="schedule.timezone"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Fuseau horaire</FormLabel>
            <FormControl>
              <Input placeholder="UTC" {...field} value={field.value ?? "UTC"} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </section>
  );
}
