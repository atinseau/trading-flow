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
import { useFormContext } from "react-hook-form";

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"] as const;
const SOURCES = ["binance", "yahoo"] as const;

export function SectionAsset() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
        Actif et timeframe
      </h3>

      <FormField
        control={f.control}
        name="id"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Identifiant</FormLabel>
            <FormControl>
              <Input placeholder="btc-1h" {...field} />
            </FormControl>
            <FormDescription>Slug unique en minuscules.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={f.control}
        name="asset.symbol"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Symbole</FormLabel>
            <FormControl>
              <Input placeholder="BTCUSDT" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={f.control}
        name="asset.source"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Source de marché</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Choisir…" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription>Binance pour le crypto, Yahoo pour les actions.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={f.control}
        name="timeframes.primary"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Timeframe principal</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {TIMEFRAMES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    </section>
  );
}
