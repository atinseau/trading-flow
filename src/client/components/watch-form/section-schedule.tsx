import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import { Input } from "../ui/input";
import { useFormContext } from "react-hook-form";

export function SectionSchedule() {
  const f = useFormContext();
  return (
    <div className="space-y-6">
      <FormField
        control={f.control}
        name="schedule.detector_cron"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Fréquence d'analyse (cron) — optionnel</FormLabel>
            <FormControl>
              <Input placeholder="ex: */15 * * * *" {...field} value={field.value ?? ""} />
            </FormControl>
            <FormDescription>
              Si tu laisses vide, le bot analyse à chaque clôture de bougie du timeframe principal
              (ex : 1h → toutes les heures pile <span className="font-mono">0 * * * *</span>).
              Override possible avec une expression cron 5-fields. Exemple :{" "}
              <span className="font-mono">*/30 * * * *</span> = toutes les 30 minutes,{" "}
              <span className="font-mono">0 8-20 * * *</span> = en haut de chaque heure entre 8h
              et 20h.
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
            <FormDescription>
              Le cron est interprété dans ce fuseau (IANA tz, ex:{" "}
              <span className="font-mono">UTC</span>, <span className="font-mono">Europe/Paris</span>,
              <span className="font-mono"> America/New_York</span>). Utile si tu veux des analyses
              alignées sur les heures de marché.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
