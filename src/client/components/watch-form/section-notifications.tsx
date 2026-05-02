import { Checkbox } from "@client/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@client/components/ui/form";
import { Switch } from "@client/components/ui/switch";
import { useFormContext } from "react-hook-form";

// Lifecycle events fired by the detector + reviewer (pre-finalizer).
// These notifications carry an inline "Kill setup" button so the user can
// short-circuit a setup that doesn't match their thesis before any LLM cost
// accumulates further.
const DETECTOR_REVIEWER_EVENTS = [
  "setup_created",
  "setup_strengthened",
  "setup_weakened",
  "setup_killed",
] as const;

// Events fired by the finalizer + tracking loop (post-confirmation).
const FINALIZER_LIFECYCLE_EVENTS = [
  "confirmed",
  "rejected",
  "tp_hit",
  "sl_hit",
  "invalidated",
  "invalidated_after_confirmed",
  "expired",
] as const;

const EVENT_GROUPS = [
  { title: "Détecteur & Reviewer", events: DETECTOR_REVIEWER_EVENTS },
  { title: "Finalizer & lifecycle", events: FINALIZER_LIFECYCLE_EVENTS },
] as const;

export function SectionNotifications() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
        Notifications Telegram
      </h3>

      <FormField
        control={f.control}
        name="notify_on"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Notifier sur</FormLabel>
            <div className="space-y-4 mt-2">
              {EVENT_GROUPS.map((group) => (
                <div key={group.title} className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.title}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {group.events.map((evt) => {
                      const checked =
                        (field.value as string[] | undefined)?.includes(evt) ?? false;
                      return (
                        <label
                          key={evt}
                          htmlFor={`notify-${evt}`}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            id={`notify-${evt}`}
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
                </div>
              ))}
            </div>
            <FormDescription>
              Le chat ID Telegram est configuré globalement par variable d'environnement. Les
              événements détecteur/reviewer incluent un bouton "Kill setup" pour annuler
              avant le finalizer.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={f.control}
        name="include_chart_image"
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <FormLabel>Joindre le graphique</FormLabel>
              <FormDescription>Image PNG annotée envoyée avec la notification.</FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />

      <FormField
        control={f.control}
        name="include_reasoning"
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <FormLabel>Inclure le raisonnement LLM</FormLabel>
              <FormDescription>Le résumé textuel apparaît dans la notification.</FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />
    </section>
  );
}
