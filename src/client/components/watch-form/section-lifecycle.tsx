import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { Slider } from "@client/components/ui/slider";
import { useFormContext } from "react-hook-form";

export function SectionLifecycle() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
        Cycle de vie d'un setup
      </h3>

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
            <FormDescription>Au-delà, le setup expire automatiquement.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={f.control}
        name="setup_lifecycle.score_threshold_finalizer"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              Seuil de confirmation : <span className="font-mono">{field.value}</span>
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
              Score à atteindre pour déclencher la décision finale GO/NO_GO.
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
                <SelectItem value="strict">Strict — toute mèche en dessous</SelectItem>
                <SelectItem value="wick_tolerant">Tolérant aux mèches</SelectItem>
                <SelectItem value="confirmed_close">Sur clôture confirmée</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    </section>
  );
}
