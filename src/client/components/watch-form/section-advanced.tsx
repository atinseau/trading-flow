import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@client/components/ui/accordion";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { Switch } from "@client/components/ui/switch";
import { useFormContext } from "react-hook-form";

export function SectionAdvanced() {
  const f = useFormContext();
  const indicators = (f.watch("indicators") ?? {}) as Record<string, { enabled: boolean }>;
  const isAtrActive = indicators.atr?.enabled === true;
  const isVolumeActive = indicators.volume?.enabled === true;
  const isRsiActive = indicators.rsi?.enabled === true;

  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="advanced">
        <AccordionTrigger>Réglages avancés</AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <FormField
            control={f.control}
            name="pre_filter.enabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <FormLabel>Pré-filtre statistique</FormLabel>
                  <FormDescription>
                    Skip les ticks où ATR / volume / RSI ne montrent rien d'intéressant.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />

          {f.watch("pre_filter.enabled") ? (
            <div className="space-y-4 rounded-lg border p-3">
              <div className="text-sm font-medium">Seuils de pré-filtrage</div>
              <FormField
                control={f.control}
                name="pre_filter.thresholds.atr_ratio_min"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>ATR ratio min</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.1"
                        min={0}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Volat. instantanée / MA20. Au-dessus, le tick passe (ex: 1.3 = +30%).
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={f.control}
                name="pre_filter.thresholds.volume_spike_min"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Volume spike min</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.1"
                        min={0}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Volume dernière bougie / MA20. Ex: 1.5 = pic +50%.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={f.control}
                name="pre_filter.thresholds.rsi_extreme_distance"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>RSI extreme distance</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="1"
                        min={0}
                        max={50}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      |RSI − 50| min pour passer. Ex: 25 = RSI &lt; 25 ou &gt; 75.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          ) : null}

          <FormField
            control={f.control}
            name="pre_filter.thresholds.atr_ratio_min"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Seuil ATR ratio minimum</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.1"
                    min={0}
                    {...field}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormDescription>
                  Ratio ATR actuel / ATR moyen requis pour passer le pré-filtre.
                </FormDescription>
                {!isAtrActive && (
                  <p className="text-xs text-muted-foreground">
                    Désactivé automatiquement (indicateur ATR non sélectionné)
                  </p>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={f.control}
            name="pre_filter.thresholds.volume_spike_min"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Seuil volume spike minimum</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.1"
                    min={0}
                    {...field}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormDescription>
                  Ratio volume actuel / volume moyen requis pour passer le pré-filtre.
                </FormDescription>
                {!isVolumeActive && (
                  <p className="text-xs text-muted-foreground">
                    Désactivé automatiquement (indicateur Volume non sélectionné)
                  </p>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={f.control}
            name="pre_filter.thresholds.rsi_extreme_distance"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Distance RSI aux extrêmes</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="1"
                    min={0}
                    max={50}
                    {...field}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormDescription>
                  Distance maximale au seuil de surachat/survente (30/70) pour passer le
                  pré-filtre.
                </FormDescription>
                {!isRsiActive && (
                  <p className="text-xs text-muted-foreground">
                    Désactivé automatiquement (indicateur RSI non sélectionné)
                  </p>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={f.control}
            name="setup_lifecycle.score_initial"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Score initial à la création</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    {...field}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={f.control}
            name="setup_lifecycle.score_threshold_dead"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Seuil de mort prématurée</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    {...field}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormDescription>Au-dessous, le setup est considéré perdu.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={f.control}
            name="optimization.reviewer_skip_when_detector_corroborated"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <FormLabel>Skip Reviewer si Detector corrobore</FormLabel>
                  <FormDescription>
                    Économise un appel LLM quand le Detector renforce de lui-même.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={f.control}
            name="optimization.allow_same_tick_fast_path"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <FormLabel>Fast-path événementiel</FormLabel>
                  <FormDescription>
                    Permet aux setups événementiels de très haute conviction (score ≥ seuil et
                    maturation = 1 tick) de passer du Detector directement au Finalizer dans le même
                    tick. Économise 15-60min sur les sweeps/breakouts clean. Désactive si tu
                    préfères toujours au moins une passe Reviewer.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />

          <div className="space-y-4 rounded-lg border p-3">
            <div>
              <div className="text-sm font-medium">Coûts de trading (R:R après frais)</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Calibre les frais pour que le Finalizer applique le R:R après coûts implicites.
                Presets : Binance perp ≈ 0.04% / 0.05% • Binance spot ≈ 0.2% / 0.05% • Yahoo
                equities ≈ 0.1% / 0.5% • Forex broker ≈ 0% / 0.02%.
              </p>
            </div>
            <FormField
              control={f.control}
              name="costs.fees_pct"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Frais (% du notionnel, aller + retour)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      max={2}
                      {...field}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={f.control}
              name="costs.slippage_pct"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Slippage attendu (%)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      max={2}
                      {...field}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={f.control}
            name="feedback.enabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <FormLabel>Feedback loop</FormLabel>
                  <FormDescription>
                    Apprend des trades clôturés défavorablement et injecte les leçons dans les
                    prompts. Désactive pour une watch de test.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={f.control}
            name="budget.max_cost_usd_per_day"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Budget LLM max / jour (USD)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="1"
                    min={0}
                    placeholder="(illimité)"
                    value={field.value ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      field.onChange(v === "" ? undefined : Number(v));
                    }}
                  />
                </FormControl>
                <FormDescription>
                  Si défini et dépassé, la watch se met en pause automatique (selon le toggle
                  ci-dessous). Vide = illimité.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={f.control}
            name="budget.pause_on_budget_exceeded"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <FormLabel>Pause sur budget dépassé</FormLabel>
                  <FormDescription>
                    Si le budget jour est défini et dépassé, met la watch en pause au lieu de
                    continuer.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
