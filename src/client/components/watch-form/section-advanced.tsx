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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { Switch } from "@client/components/ui/switch";
import { useFormContext } from "react-hook-form";

/** Small visual hint shown below an input when its owning indicator plugin is
 * not enabled in the Indicateurs step. The threshold is kept in the schema
 * (so values persist across toggles) but the input is disabled to make the
 * dependency obvious. Color is amber (warning, not error) per UX spec. */
function PluginInactiveHint({ label }: { label: string }) {
  return (
    <p className="text-xs text-amber-600 dark:text-amber-400">
      Activé uniquement si l'indicateur <strong>{label}</strong> est coché dans la step
      Indicateurs.
    </p>
  );
}

export function SectionAdvanced() {
  const f = useFormContext();
  const indicators = (f.watch("indicators") ?? {}) as Record<string, { enabled?: boolean }>;
  const isAtrActive = indicators.atr?.enabled === true;
  const isVolumeActive = indicators.volume?.enabled === true;
  const isRsiActive = indicators.rsi?.enabled === true;
  const isStructureLevelsActive = indicators.structure_levels?.enabled === true;

  const preFilterEnabled = f.watch("pre_filter.enabled") === true;
  const preFilterMode = f.watch("pre_filter.mode") as "lenient" | "strict" | "off" | undefined;
  const showThresholds = preFilterEnabled && preFilterMode !== "off";
  const feedbackEnabled = f.watch("feedback.enabled") === true;

  return (
    <Accordion type="multiple" defaultValue={["pre_filter"]} className="space-y-2">
      {/* ────────────────────────────── 1. PRÉ-FILTRE ─────────────────────────── */}
      <AccordionItem value="pre_filter">
        <AccordionTrigger>
          <div className="flex w-full flex-col">
            <div className="flex items-center gap-2">
              <span aria-hidden>⚡</span>
              <span>Pré-filtre statistique</span>
              {!preFilterEnabled && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  désactivé
                </span>
              )}
            </div>
            <p className="mt-1 text-left text-xs text-muted-foreground">
              Filtre les ticks dont aucun critère statistique ne sort du bruit (volatilité, volume,
              RSI, distance aux pivots). Économise des appels LLM.
            </p>
          </div>
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <FormField
            control={f.control}
            name="pre_filter.enabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <FormLabel>Activer le pré-filtre</FormLabel>
                  <FormDescription>
                    Désactive entièrement le pré-filtrage : tous les ticks sont alors traités.
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
            name="pre_filter.mode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Mode</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="lenient">
                      <div className="flex flex-col">
                        <span>Lenient</span>
                        <span className="text-xs text-muted-foreground">
                          Le tick passe si AU MOINS UN critère statistique se déclenche
                        </span>
                      </div>
                    </SelectItem>
                    <SelectItem value="strict">
                      <div className="flex flex-col">
                        <span>Strict</span>
                        <span className="text-xs text-muted-foreground">
                          Le tick passe seulement si TOUS les critères actifs se déclenchent
                        </span>
                      </div>
                    </SelectItem>
                    <SelectItem value="off">
                      <div className="flex flex-col">
                        <span>Off</span>
                        <span className="text-xs text-muted-foreground">
                          Pas de pré-filtrage, tous les ticks passent
                        </span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {showThresholds ? (
            <div className="space-y-4 rounded-lg border p-3">
              <div className="text-sm font-medium">Seuils par critère</div>

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
                        disabled={!isAtrActive}
                        className={!isAtrActive ? "opacity-50 cursor-not-allowed" : ""}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Volatilité instantanée / MA20. Au-dessus, le tick passe (ex: 1.3 = +30%).
                    </FormDescription>
                    {!isAtrActive && <PluginInactiveHint label="ATR" />}
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
                        disabled={!isVolumeActive}
                        className={!isVolumeActive ? "opacity-50 cursor-not-allowed" : ""}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Volume dernière bougie / MA20. Ex: 1.5 = pic +50%.
                    </FormDescription>
                    {!isVolumeActive && <PluginInactiveHint label="Volume" />}
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
                        disabled={!isRsiActive}
                        className={!isRsiActive ? "opacity-50 cursor-not-allowed" : ""}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      |RSI − 50| min pour passer. Ex: 25 = RSI &lt; 25 ou &gt; 75.
                    </FormDescription>
                    {!isRsiActive && <PluginInactiveHint label="RSI" />}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={f.control}
                name="pre_filter.thresholds.near_pivot_distance_pct"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Distance aux pivots (%)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.1"
                        min={0}
                        max={2}
                        disabled={!isStructureLevelsActive}
                        className={
                          !isStructureLevelsActive ? "opacity-50 cursor-not-allowed" : ""
                        }
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Distance max au plus haut/bas récent (% du prix). Ex: 0.3 = passe si à moins
                      de 0.3% d'un pivot.
                    </FormDescription>
                    {!isStructureLevelsActive && (
                      <PluginInactiveHint label="Niveaux de structure" />
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          ) : null}
        </AccordionContent>
      </AccordionItem>

      {/* ────────────────────────────── 2. VIE D'UN SETUP ──────────────────────── */}
      <AccordionItem value="setup_lifecycle">
        <AccordionTrigger>
          <div className="flex w-full flex-col">
            <div className="flex items-center gap-2">
              <span aria-hidden>🎯</span>
              <span>Vie d'un setup</span>
            </div>
            <p className="mt-1 text-left text-xs text-muted-foreground">
              Comment un setup naît, vit, et meurt. Les seuils de score et la politique
              d'invalidation.
            </p>
          </div>
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
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
                <FormDescription>
                  Score attribué au setup quand il vient d'être détecté (avant Reviewer/Finalizer).
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={f.control}
            name="setup_lifecycle.score_max"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Score plafond</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    {...field}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormDescription>
                  Plafond imposé aux mises à jour de score. <span className="font-mono">100</span>{" "}
                  par défaut.
                </FormDescription>
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
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={f.control}
            name="setup_lifecycle.min_risk_reward_ratio"
            render={({ field }) => (
              <FormItem>
                <FormLabel>R:R minimum</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="0.1"
                    min={1}
                    max={10}
                    {...field}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormDescription>
                  Reward/risk minimal exigé par le Finalizer pour valider un GO. 2 = TP doit être ≥
                  2× la distance entry → SL.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </AccordionContent>
      </AccordionItem>

      {/* ────────────────────────────── 3. OPTIMISATION ────────────────────────── */}
      <AccordionItem value="optimization">
        <AccordionTrigger>
          <div className="flex w-full flex-col">
            <div className="flex items-center gap-2">
              <span aria-hidden>⚙️</span>
              <span>Optimisation pipeline</span>
            </div>
            <p className="mt-1 text-left text-xs text-muted-foreground">
              Réglages d'économie LLM. Désactive si tu préfères toujours tous les passes Reviewer +
              Finalizer.
            </p>
          </div>
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
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
                    maturation = 1 tick) de passer du Detector directement au Finalizer dans le
                    même tick. Économise 15-60min sur les sweeps/breakouts clean. Désactive si tu
                    préfères toujours au moins une passe Reviewer.
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

      {/* ────────────────────────────── 4. COÛTS DE TRADING ────────────────────── */}
      <AccordionItem value="costs">
        <AccordionTrigger>
          <div className="flex w-full flex-col">
            <div className="flex items-center gap-2">
              <span aria-hidden>💰</span>
              <span>Coûts de trading</span>
            </div>
            <p className="mt-1 text-left text-xs text-muted-foreground">
              Calibre les frais et le slippage pour que le R:R du Finalizer soit calculé après
              coûts implicites.
            </p>
          </div>
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <p className="text-xs text-muted-foreground">
            Presets : Binance perp ≈ 0.04% / 0.05% • Binance spot ≈ 0.2% / 0.05% • Yahoo equities
            ≈ 0.1% / 0.5% • Forex broker ≈ 0% / 0.02%.
          </p>
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
        </AccordionContent>
      </AccordionItem>

      {/* ────────────────────────────── 5. FEEDBACK LOOP ───────────────────────── */}
      <AccordionItem value="feedback">
        <AccordionTrigger>
          <div className="flex w-full flex-col">
            <div className="flex items-center gap-2">
              <span aria-hidden>🧠</span>
              <span>Feedback loop</span>
              {!feedbackEnabled && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  désactivé
                </span>
              )}
            </div>
            <p className="mt-1 text-left text-xs text-muted-foreground">
              Le bot analyse les setups perdants et génère des leçons textuelles qu'il injecte dans
              les prompts à venir. Désactive pour une watch de test ou pour économiser des tokens.
            </p>
          </div>
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
          <FormField
            control={f.control}
            name="feedback.enabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <FormLabel>Activer la feedback loop</FormLabel>
                  <FormDescription>
                    Apprend des trades clôturés défavorablement et injecte les leçons dans les
                    prompts.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />

          {feedbackEnabled ? (
            <>
              <FormField
                control={f.control}
                name="feedback.max_active_lessons_per_category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Leçons actives max par catégorie</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="1"
                        min={1}
                        max={200}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Au-delà, les anciennes leçons sont archivées (LRU sur date d'usage).
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="space-y-4 rounded-lg border p-3">
                <div>
                  <div className="text-sm font-medium">Injection des leçons par stage</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Choisis à quels stages du pipeline les leçons sont injectées. Désactiver un
                    stage économise des tokens mais réduit l'effet d'apprentissage.
                  </p>
                </div>

                <FormField
                  control={f.control}
                  name="feedback.injection.detector"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border p-3">
                      <div>
                        <FormLabel>Detector</FormLabel>
                        <FormDescription>
                          Inject les leçons dans le prompt de détection initiale.
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
                  name="feedback.injection.reviewer"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border p-3">
                      <div>
                        <FormLabel>Reviewer</FormLabel>
                        <FormDescription>
                          Inject les leçons dans le prompt de revue intermédiaire.
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
                  name="feedback.injection.finalizer"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border p-3">
                      <div>
                        <FormLabel>Finalizer</FormLabel>
                        <FormDescription>
                          Inject les leçons dans le prompt de décision finale GO/NO_GO.
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
            </>
          ) : null}
        </AccordionContent>
      </AccordionItem>

      {/* ────────────────────────────── 6. BUDGET LLM & AVANCÉ ─────────────────── */}
      <AccordionItem value="budget">
        <AccordionTrigger>
          <div className="flex w-full flex-col">
            <div className="flex items-center gap-2">
              <span aria-hidden>💵</span>
              <span>Budget LLM & avancé</span>
            </div>
            <p className="mt-1 text-left text-xs text-muted-foreground">
              Plafonne le coût LLM par jour, ajuste la fenêtre d'historique compactée, et règle la
              déduplication des setups similaires.
            </p>
          </div>
        </AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">
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

          <div className="space-y-4 rounded-lg border p-3">
            <div>
              <div className="text-sm font-medium">Compaction de l'historique</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Contrôle combien d'événements bruts sont injectés dans le contexte LLM avant que
                les plus anciens soient résumés.
              </p>
            </div>

            <FormField
              control={f.control}
              name="history_compaction.max_raw_events_in_context"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Événements bruts max dans le contexte</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="1"
                      min={1}
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
              name="history_compaction.summarize_after_age_hours"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Âge du résumé (heures)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="1"
                      min={1}
                      {...field}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormDescription>
                    Au-delà, les événements sont condensés dans un résumé avant injection.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="space-y-4 rounded-lg border p-3">
            <div>
              <div className="text-sm font-medium">Déduplication des setups</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Évite de créer deux setups quasi-identiques rapprochés dans le temps.
              </p>
            </div>

            <FormField
              control={f.control}
              name="deduplication.similar_setup_window_candles"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Fenêtre de comparaison (bougies)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="1"
                      min={1}
                      {...field}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormDescription>
                    Combien de bougies en arrière sont scannées pour détecter un setup similaire.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={f.control}
              name="deduplication.similar_price_tolerance_pct"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tolérance prix (%)</FormLabel>
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
                    Deux setups sont considérés similaires si leur entry diffère de moins de ce %.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
