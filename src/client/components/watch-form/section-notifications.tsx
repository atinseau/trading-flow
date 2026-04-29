import { Checkbox } from "@client/components/ui/checkbox";
import {
  FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from "@client/components/ui/form";
import { Switch } from "@client/components/ui/switch";
import { useFormContext } from "react-hook-form";

const EVENTS = [
  "confirmed", "rejected", "tp_hit", "sl_hit",
  "invalidated", "invalidated_after_confirmed", "expired",
] as const;

export function SectionNotifications() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
        Notifications Telegram
      </h3>

      <FormField control={f.control} name="notify_on" render={({ field }) => (
        <FormItem>
          <FormLabel>Notifier sur</FormLabel>
          <div className="grid grid-cols-2 gap-2 mt-2">
            {EVENTS.map((evt) => {
              const checked = (field.value as string[] | undefined)?.includes(evt) ?? false;
              return (
                <label key={evt} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => {
                      const cur = (field.value as string[] | undefined) ?? [];
                      field.onChange(v ? [...cur, evt] : cur.filter((e) => e !== evt));
                    }}
                  />
                  <span>{evt}</span>
                </label>
              );
            })}
          </div>
          <FormDescription>
            Le chat ID Telegram est configuré globalement par variable d'environnement.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )} />

      <FormField control={f.control} name="include_chart_image" render={({ field }) => (
        <FormItem className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <FormLabel>Joindre le graphique</FormLabel>
            <FormDescription>Image PNG annotée envoyée avec la notification.</FormDescription>
          </div>
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )} />

      <FormField control={f.control} name="include_reasoning" render={({ field }) => (
        <FormItem className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <FormLabel>Inclure le raisonnement LLM</FormLabel>
            <FormDescription>Le résumé textuel apparaît dans la notification.</FormDescription>
          </div>
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )} />
    </section>
  );
}
