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
import { useFormContext } from "react-hook-form";

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"] as const;
const SOURCES = [
  { value: "binance", label: "Binance", hint: "Crypto — WebSocket temps réel" },
  { value: "yahoo", label: "Yahoo Finance", hint: "Actions / indices / forex" },
] as const;

export function SectionAsset() {
  const f = useFormContext();
  return (
    <div className="space-y-6">
      <FormField
        control={f.control}
        name="id"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Identifiant</FormLabel>
            <FormControl>
              <Input placeholder="btc-1h" {...field} />
            </FormControl>
            <FormDescription>
              Slug unique pour cette watch (lettres minuscules, chiffres, tirets). Apparaît dans les
              notifications, les logs, et les commandes admin. Pas modifiable après création.
            </FormDescription>
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
            <FormDescription>
              Le ticker tel qu'il est exposé par la source. Exemples :
              <span className="font-mono"> BTCUSDT</span>,
              <span className="font-mono"> ETHUSDT</span> (Binance),
              <span className="font-mono"> AAPL</span>,<span className="font-mono"> ^GSPC</span>{" "}
              (Yahoo).
            </FormDescription>
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
                  <SelectItem key={s.value} value={s.value}>
                    <div className="flex flex-col">
                      <span>{s.label}</span>
                      <span className="text-xs text-muted-foreground">{s.hint}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            <FormDescription>
              Granularité des bougies analysées. Détermine aussi la fréquence d'analyse par défaut
              (alignée sur la fermeture de chaque bougie). Plus court = plus de signaux + plus de
              coût LLM.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
