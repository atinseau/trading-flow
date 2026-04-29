import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Slider } from "../ui/slider";
import { useFormContext } from "react-hook-form";

export function SectionLifecycle() {
  const f = useFormContext();
  return (
    <div className="space-y-6">
      <FormField
        control={f.control}
        name="setup_lifecycle.ttl_candles"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Durée de vie max (en bougies)</FormLabel>
            <FormControl>
              <Input
                type="number"
                {...field}
                onChange={(e) => field.onChange(Number(e.target.value))}
              />
            </FormControl>
            <FormDescription>
              Au-delà de N bougies sans confirmation, le setup expire automatiquement (status
              {" "}
              <span className="font-mono">EXPIRED</span>). Exemple : 50 bougies sur un timeframe
              1h ≈ 50 heures.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={f.control}
        name="setup_lifecycle.score_threshold_finalizer"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="flex items-center justify-between">
              <span>Seuil de confirmation</span>
              <span className="font-mono text-sm">{field.value} / 100</span>
            </FormLabel>
            <FormControl>
              <Slider
                min={50}
                max={100}
                step={5}
                value={[field.value ?? 80]}
                onValueChange={(v) => field.onChange(v[0])}
              />
            </FormControl>
            <FormDescription>
              Score minimal pour déclencher le <strong>Finalizer</strong> (qui tranche en GO/NO_GO
              et envoie la notification Telegram). Plus bas = notifs plus fréquentes mais plus de
              faux positifs. <span className="font-mono">80</span> est un bon point de départ.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={f.control}
        name="setup_lifecycle.invalidation_policy"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Politique d'invalidation</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="strict">
                  <div className="flex flex-col">
                    <span>Strict</span>
                    <span className="text-xs text-muted-foreground">
                      Toute mèche en dessous du niveau d'invalidation tue le setup
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="wick_tolerant">
                  <div className="flex flex-col">
                    <span>Tolérant aux mèches</span>
                    <span className="text-xs text-muted-foreground">
                      Une mèche peut perforer brièvement, mais pas tenir
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="confirmed_close">
                  <div className="flex flex-col">
                    <span>Sur clôture confirmée</span>
                    <span className="text-xs text-muted-foreground">
                      Seul un close en dessous invalide. Le plus permissif.
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            <FormDescription>
              Quand considère-t-on qu'un setup est "cassé" ? Strict évite les pièges mais perd vite
              des setups. Permissif survit aux fausses cassures mais peut traîner sur des setups
              morts.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
