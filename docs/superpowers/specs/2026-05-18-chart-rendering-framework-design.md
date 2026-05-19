# Chart Rendering Framework — Design Document

**Date** : 2026-05-18
**Status** : Draft — pending review
**Auteur** : brainstorming Arthur + Claude

---

## 0. Contexte

Le projet expose actuellement **5 chemins distincts** qui touchent à `lightweight-charts` v5 :

| # | Path | Fichier | Indicateurs ? |
|---|---|---|---|
| 1 | Backend Playwright (image LLM) | `src/adapters/chart/PlaywrightChartRenderer.ts` + `chart-template.html` | ✅ Plugin system complet |
| 2 | Frontend replay session | `src/client/components/replay/replay-chart.tsx` + `applyIndicatorToChart.ts` + `PriceBandsOverlay.tsx` | ✅ Plugin system complet |
| 3 | Frontend setup detail | `src/client/components/setup/tv-chart.tsx` | ❌ Aucun, juste priceLines |
| 4 | Frontend asset browse | `src/client/components/asset/asset-chart.tsx` | ❌ Volume hard-codé uniquement |
| 5 | HTML template Playwright | `src/adapters/chart/chart-template.html` (script inline JS) | Bootstrap + plugin invocation |

Onze plugins indicateurs existent dans `src/adapters/indicators/plugins/` : `ema_stack`, `rsi`, `bollinger`, `macd`, `atr`, `vwap`, `volume`, `swings_bos`, `structure_levels`, `liquidity_pools`, `fibonacci`. Chaque plugin contient :
- `compute.ts` — math pure (`(candles, params) → contribution`)
- `chartScript.ts` — **JS string** eval'd par Playwright dans la page headless
- `promptFragments.ts` — formatte les scalars pour le prompt LLM
- `metadata.ts` — id, tag, paramsDescriptor
- `index.ts` — glue

Le contrat de rendu partagé est `IndicatorSeriesContribution`, une union discriminée de `kind` (`lines | priceLines | markers | histogram | bands | compound`). C'est la seule chose qui est vraiment partagée entre les 2 dispatchers d'indicateurs.

## 1. Problèmes constatés

### 1.1 Drift entre les deux dispatchers d'indicateurs

Les 2 dispatchers (frontend `applyIndicatorToChart.ts` + backend `chartScript.ts` per-plugin) ont des architectures **opposées** :

| | Frontend (replay) | Backend (Playwright) |
|---|---|---|
| Style | dispatcher générique unifié, switch sur `contribution.kind` | per-plugin chartScript, chaque plugin owns sa logique de rendu |
| Type safety | TS strict, kind-discriminated | string JS, zero type |
| Évolution d'un kind | touche 1 dispatcher | touche N chartScripts |
| Drift detection | TS compile-time | aucune (testé visuellement) |

**Conséquence factuelle** : quand le plugin Fibonacci a muté `kind: "priceLines"` → `kind: "compound"` (pour exposer bands + markers), le frontend l'a absorbé silencieusement (le switch unifié gère `compound`), le backend l'a skippé silencieusement (chartScript per-plugin restait sur `kind !== "priceLines" return`). Fib invisible sur l'image LLM pendant plusieurs jours, bug détecté visuellement, pas par tests.

### 1.2 Duplication du chart bootstrap

Quatre endroits (`replay-chart`, `tv-chart`, `asset-chart`, `chart-template.html`) font tous la même chose :
- `createChart(container, opts)` avec config quasi-identique
- `addSeries(CandlestickSeries, candleColors)` avec couleurs *presque* identiques
- Resize listener
- Cleanup au démontage

Diff principal : palette candles (deux verts différents `#26a69a` vs `#10b981` selon le path), grids, panes config. **Le LLM voit du `#26a69a`, l'utilisateur regardant la même session sur la page setup voit du `#10b981`.**

### 1.3 Couplage chart-template ↔ chartScripts via globals window

Le mécanisme actuel d'enregistrement plugin → render :
1. `chart-template.html` setup `window.__chartPlugins = {}`
2. Chaque `chartScript.ts` appelle `window.__registerPlugin(id, {addToChart, setData})`
3. `__renderCandles(payload)` itère sur `enabledIndicatorIds` et invoke `window.__chartPlugins[id].setData(...)`

Pas d'isolation, dépendance globale, impossible à tester unitairement, impossible à typer.

### 1.4 Pas de single source of truth pour les couleurs / labels

`replay-chart.tsx` définit `INDICATOR_PALETTES`, `SERIES_LABELS` map. Les chartScripts backend redéfinissent les mêmes couleurs en strings JS (`mk("#42a5f5", 1, "EMA Short")` dans `ema_stack/chartScript.ts`). Quand on change la palette, on change à 2 endroits.

## 2. Goals

1. **Un seul moteur de rendu d'indicateurs** — même TS, exécuté indifféremment dans React (frontend) et Playwright (backend headless).
2. **Plugins purement TS** — disparition de `chartScript.ts` (JS strings) ; le plugin déclare ses préférences de rendu en TS, jamais en JS template literal.
3. **API publique unifiée** : `<TradingViewChart indicators={...} />` pour le frontend, `renderChartImage({ indicators, ... })` pour le backend. Les deux acceptent la **même config**.
4. **Pas de changement visuel** sauf breaking changes assumés (palette unifiée, mais positions et data identiques aux pixels près sur les cas de référence).
5. **Visibilité garantie des bougies** — quel que soit le nombre d'indicateurs activés, **aucune bougie ne doit être masquée** par les labels axe-droite. Implémentation : `timeScale().applyOptions({ rightOffset: N })` où `N` est calculé dynamiquement en fonction de la densité des labels (nombre d'indicateurs `price_overlay` + nb de priceLines). Le LLM doit pouvoir voir la dernière bougie close, c'est la plus actionable.
6. **Bands Fibonacci (et tout futur `kind: "bands"`) rendues dans les deux contextes** — frontend ET backend. Implémentation : `ISeriesPrimitive` natif lightweight-charts v5 (canvas custom), partagé via le module unifié. L'HTML overlay actuel (`PriceBandsOverlay.tsx`) disparaît.
7. **Contrôles d'indicateurs built-in au framework** — `<TradingViewChart enableControls />` expose un panneau (sidebar / checkboxes / chips) qui permet à l'utilisateur de toggle quels indicateurs sont visibles **après le premier rendu**. Le state vit dans le composant, pas chez le caller. Le code actuel `IndicatorToggles` + `visibleIndicatorIds` state dispersé dans `replay-session.tsx` disparaît. **Opt-in** : default `enableControls={false}` → chart read-only (pour setup detail, asset detail, image LLM). Replay l'active.
8. **Backend non-contrôlable** : le pipeline (Playwright) ignore tout concept de "controls". Le watch dicte ce qui est rendu, point. C'est une garantie sémantique : `enableControls` n'a aucun effet côté backend.
9. **Gestion explicite des panes secondaires** — RSI, MACD, ATR, Volume sont chacun rendus dans une pane séparée. Le framework alloue déterministiquement (ordre = ordre des indicateurs dans la config) et applique `setStretchFactor` selon `renderConfig.secondaryPaneStretch`. Un toggle visibility (Goal #7) qui désactive RSI doit faire **disparaître sa pane** (pas juste cacher la série).
10. **Loading on-demand** — un caller qui veut un chart avec `[rsi, ema_stack]` ne paie le coût de bundling que pour ces plugins-là.
11. **Hexagonale** — port `ChartRenderer` (existant), nouveau port `IndicatorPlugin` (TS, sans dépendance lightweight-charts au compile-time), adapters par contexte. Cohérent avec le reste du projet (cf. `src/domain/ports/`).
12. **Testable** — chaque plugin compute testé en isolation, le dispatcher testé avec un faux chart, l'intégration via screenshots.
13. **Validation via Storybook** — chaque plugin / state du framework (densités, toggle visibility, fullscreen, naked mode, etc.) a une story. Storybook devient le **golden path de validation visuelle frontend**, qui sert AUSSI de fixture pour les tests backend d'extraction d'image (PlaywrightChartRenderer). Si une story rend correctement visuellement → un test unitaire backend extrait la même config en webp et l'asserte SHA256-stable.

## 3. Non-goals

- **Pas de migration vers une autre lib** (TradingView Advanced Charting Library, deepentropy, etc.). On reste sur `lightweight-charts` v5 open-source.
- **Pas de framework UI réutilisable hors trading-flow.** C'est de l'internal tooling. Pas de package publié.
- **Pas de drawing tools interactifs** dans cette itération (trait, rectangle, fibonacci-à-main). Les indicateurs gardent leur ancrage automatique calculé.
- **Pas de runtime hot-reload des plugins.** L'enregistrement reste statique (resolved à build time pour le bundle frontend, au démarrage du worker pour le backend).

## 4. Architecture

### 4.1 Vue d'ensemble

```
                   ┌─────────────────────────────┐
                   │   src/domain/charts/        │  ← Ports + types purs
                   │  - IndicatorPlugin (port)   │
                   │  - IndicatorSeriesContribution
                   │  - ChartConfig              │
                   └──────┬──────────────────────┘
                          │
        ┌─────────────────┴────────────────┐
        │                                  │
        ▼                                  ▼
┌───────────────────────────┐   ┌───────────────────────────┐
│ src/adapters/indicators/  │   │ src/adapters/chart/       │
│  plugins/                 │   │  - contributionRenderer.ts│  ← LE renderer unifié
│  - ema_stack/             │   │  - chartBootstrap.ts      │  ← createChart + candles
│  - rsi/                   │   │  - PlaywrightChartRenderer│
│  - fibonacci/             │   │    (utilise les 2 ci-dessus
│  - ...                    │   │     pour rendre l'image)  │
│  Chacun expose :          │   └───────────────────────────┘
│  - compute()              │                  │
│  - renderConfig {pane,    │                  │
│      palette, labels}     │                  │
│  - paramsSchema           │                  │
│  - metadata               │                  │
└───────────┬───────────────┘                  │
            │                                  │
            ▼                                  ▼
┌─────────────────────────────────────────────────────────┐
│ src/client/components/charts/                           │
│  - TradingViewChart.tsx ← composant React principal    │
│  - useTradingViewChart.ts (hook si besoin)              │
│ Utilise contributionRenderer + chartBootstrap.          │
│ Remplace : replay-chart.tsx, tv-chart.tsx,              │
│            asset-chart.tsx (qui deviennent de fines     │
│            wrappers feature-specific).                  │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Layers

1. **Domain (pure, zero dep)** : `src/domain/charts/`
   - Types : `IndicatorSeriesContribution`, `ChartCandleStyle`, `ChartConfig`
   - Port : `IndicatorPlugin` interface
   - Aucun import de `lightweight-charts` (même type-only — découpler le domain de la lib de rendu)

2. **Indicator plugins (adapters)** : `src/adapters/indicators/plugins/`
   - Chaque plugin implémente le port `IndicatorPlugin`
   - Pas de `chartScript.ts` plus jamais
   - Compute reste pure TS

3. **Renderer core (adapter)** : `src/adapters/chart/`
   - `contributionRenderer.ts` — `applyContribution(chart, contribution, prefs)` qui dispatch sur kind. Utilise `globalThis.LightweightCharts` au runtime (compatible browser + Playwright).
   - `chartBootstrap.ts` — `createTradingViewChart(container, opts)` qui crée chart + candle series. Palette unique, layout unique.

4. **React adapter** : `src/client/components/charts/TradingViewChart.tsx`
   - Composant React qui :
     - Boot le chart via `chartBootstrap`
     - Pour chaque indicator dans la prop : invoque `contributionRenderer.applyContribution`
     - Gère resize, cleanup, fullscreen
   - Remplace progressivement les 3 composants frontend existants

5. **Playwright adapter** : `src/adapters/chart/PlaywrightChartRenderer.ts` (refacto)
   - Bootstrap : page Playwright → injecte `lightweight-charts.standalone.production.js` → injecte le module `contributionRenderer` (transpilé via `Bun.Transpiler` au warm-up) + `chartBootstrap` → expose les fonctions sur `window.__tradingFlowChart`
   - `render(args)` : navigate → call `window.__tradingFlowChart.render(args)` → screenshot → resize → WebP

### 4.3 Plugin contract

Nouveau port `src/domain/charts/IndicatorPlugin.ts` (ou extension du port existant `src/domain/services/IndicatorPlugin.ts` qui inclut déjà compute + metadata) :

```ts
export interface IndicatorPlugin<P extends Record<string, unknown> = Record<string, unknown>> {
  // ─── Identity ──────────────────────────────────────────
  readonly id: string;
  readonly displayName: string;
  readonly tag: 'trend' | 'momentum' | 'volatility' | 'volume' | 'structure' | 'liquidity';

  // ─── Compute (pure) ────────────────────────────────────
  compute(candles: Candle[], params: P): IndicatorSeriesContribution;
  computeScalars?(candles: Candle[], params: P): Record<string, number | string | null>;

  // ─── Params ────────────────────────────────────────────
  readonly defaultParams: P;
  readonly paramsSchema: ZodSchema<P>;

  // ─── Render preferences (declarative) ──────────────────
  readonly renderConfig: {
    pane: 'price_overlay' | 'secondary';
    /** Palette per series. Index N → Nth named series in `lines.series`. */
    palette: ReadonlyArray<string>;
    /** Optional human label per series name. Falls back to "id:name". */
    seriesLabels?: Readonly<Record<string, string>>;
    /** Pixel-stretch for secondary panes (rsi=13, macd=15, etc). */
    secondaryPaneStretch?: number;
  };

  // ─── Prompt / metadata (existing, unchanged) ───────────
  getPromptData(...): IndicatorPromptData;
  // ...
}
```

**Clé** : `renderConfig` est **déclaratif**, jamais d'invocation lightweight-charts ici. Le plugin dit "voici mes couleurs, voici sur quelle pane", pas "voici comment me dessiner". Le renderer générique fait le dessin.

### 4.4 Renderer core

`src/adapters/chart/contributionRenderer.ts` — pure TS, exporte :

```ts
export type ApplyContributionOpts = {
  /** Plugin id — used to resolve `renderConfig` (palette, labels). */
  id: string;
  /** Plugin's declared renderConfig. */
  renderConfig: IndicatorPlugin['renderConfig'];
  /** Candle timestamps (UTC seconds). */
  candleTimes: UTCTimestamp[];
  /** Main candle series for `priceLines`. */
  mainSeries: ISeriesApi<'Candlestick'>;
  /** Mutable marker bucket — markers from this indicator get pushed in. */
  markerBucket: SeriesMarker<Time>[];
};

export function applyContribution(
  chart: IChartApi,
  contribution: IndicatorSeriesContribution,
  opts: ApplyContributionOpts,
): { cleanup(): void };
```

Dispatch interne **sur `contribution.kind`** :
- `lines` → `chart.addSeries(LineSeries, ...)` × N, sur le pane resolved par `renderConfig.pane`
- `priceLines` → `mainSeries.createPriceLine(...)` × N
- `markers` → push dans `markerBucket` (le parent committe avec `createSeriesMarkers`)
- `histogram` → `chart.addSeries(HistogramSeries, ...)` sur pane secondaire
- `bands` → **attach `ISeriesPrimitive` au candle series**, qui dessine les rectangles en canvas (`paneViews()` → `IPrimitivePaneView` → `renderer().draw(target)`). Rendu **identique** frontend et backend (canvas-based, pas HTML). L'overlay `PriceBandsOverlay.tsx` actuel disparaît. Voir §4.5bis pour le détail de la primitive.
- `compound` → recurse sur chaque part

Runtime : accède aux constantes lightweight-charts via `globalThis.LightweightCharts` :
- Frontend setup file `setupLightweightChartsGlobal.ts` expose `import * as LC; globalThis.LightweightCharts = LC;` au boot
- Backend Playwright a `window.LightweightCharts` exposé par le standalone bundle

### 4.5 Chart bootstrap

`src/adapters/chart/chartBootstrap.ts` :

```ts
export type ChartBootstrapOpts = {
  width: number;
  height: number;
  /** Naked = no indicators ; lighter grid, candle border visible. */
  naked: boolean;
  /** Override candle styling — defaults to the canonical candle palette
   *  (`#26a69a` / `#ef5350`). Indicator colors live in each plugin's
   *  `renderConfig`, not here. */
  styleOverrides?: Partial<ChartCandleStyle>;
};

export type ChartBootstrapResult = {
  chart: IChartApi;
  candleSeries: ISeriesApi<'Candlestick'>;
  /** Tear down. */
  dispose(): void;
};

export function createTradingViewChart(
  container: HTMLDivElement,
  opts: ChartBootstrapOpts,
): ChartBootstrapResult;
```

Une seule palette canonique (`#26a69a` / `#ef5350`, alignée sur lightweight-charts defaults) utilisée par tous les chemins. Élimine la divergence des verts.

### 4.5bis Bands primitive (`ISeriesPrimitive`)

`src/adapters/chart/bandsPrimitive.ts` — implémentation canvas-based des bandes Fibonacci (et tout futur `kind: "bands"`). Renderable **identiquement** côté frontend et backend (la primitive vit dans la même surface canvas que le candle series).

```ts
import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  Time,
} from "lightweight-charts";

export type Band = {
  topPrice: number;
  bottomPrice: number;
  fillColor: string;   // rgba (alpha < 0.4 pour ne pas masquer les candles)
  label?: string;
  fromTime?: Time;
  toTime?: Time;
};

export class BandsPrimitive implements ISeriesPrimitive<Time> {
  constructor(
    private series: ISeriesApi<"Candlestick">,
    private bands: Band[],
  ) {}

  paneViews(): readonly IPrimitivePaneView[] {
    return [
      {
        zOrder: () => "bottom",  // sous les candles, pas par-dessus
        renderer: () => new BandsRenderer(this.series, this.bands),
      },
    ];
  }

  setBands(bands: Band[]): void {
    this.bands = bands;
    this.series.attachPrimitive(this);  // force redraw
  }
}

class BandsRenderer implements IPrimitivePaneRenderer {
  constructor(
    private series: ISeriesApi<"Candlestick">,
    private bands: Band[],
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace(({ context, bitmapSize }) => {
      const priceScale = this.series.priceScale();
      const timeScale = /* chart.timeScale() — accessed via series.api */;
      for (const band of this.bands) {
        const y1 = this.series.priceToCoordinate(band.topPrice);
        const y2 = this.series.priceToCoordinate(band.bottomPrice);
        if (y1 == null || y2 == null) continue;
        const x1 = band.fromTime ? timeScale.timeToCoordinate(band.fromTime) ?? 0 : 0;
        const x2 = band.toTime ? timeScale.timeToCoordinate(band.toTime) ?? bitmapSize.width : bitmapSize.width;
        context.fillStyle = band.fillColor;
        context.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
      }
    });
  }
}
```

Le `contributionRenderer` invoke la primitive via :
```ts
case "bands": {
  const primitive = new BandsPrimitive(opts.mainSeries, c.bands);
  opts.mainSeries.attachPrimitive(primitive);
  createdPrimitives.push({ series: opts.mainSeries, primitive });
  return;
}
```

Cleanup : `mainSeries.detachPrimitive(primitive)` dans le `cleanup()` retourné.

**Conséquences** :
- `src/client/components/replay/PriceBandsOverlay.tsx` **disparaît** (Phase 6 de la migration).
- L'image LLM contient **les bandes Fib visiblement**. Le LLM voit la golden zone, plus seulement les niveaux numérotés.
- Le rendu est canvas (intégré au framebuffer du chart), donc le `chart.remove()` + `priceToCoordinate` clamping vu sur l'HTML overlay actuel disparaissent (le primitive est synchronisé avec la lifecycle du chart par lightweight-charts).

### 4.5ter RightOffset adaptatif — visibilité garantie des bougies

Problème observé : avec 6+ indicateurs `price_overlay` activés (EMA stack × 3, BB × 2, Fib × 5+, structure_levels × 2-5), les labels axe-droite (`BB Up`, `EMA Short`, `Fib 0.382`, etc.) cluster sur les ~15-30% droits du chart et **masquent les 3-5 dernières bougies**. Le LLM rate ce qui est le plus actionable (le mouvement le plus récent).

Solution : `chart.timeScale().applyOptions({ rightOffset: N })` où `N` est calculé dynamiquement par `chartBootstrap` après application de tous les indicateurs :

```ts
function computeRightOffset(opts: {
  /** Number of price-overlay line series rendered. */
  priceOverlayLineCount: number;
  /** Number of priceLines on main series (Fib, structure HH/LL, FVG, etc). */
  priceLineCount: number;
}): number {
  // Each label is ~12-15px tall. With visible-stack-spacing in lightweight-charts,
  // labels can't overlap → they push each other vertically. When stacked count
  // exceeds ~6, labels overflow horizontally into the candle area.
  //
  // Empirical : `rightOffset` in candles → push the rightmost real candle
  // N candles to the left, creating an N-candle empty zone where labels live.
  //
  // Tuned values (see test/fixtures/chart-screenshots/right-offset-*.png) :
  //   total labels ≤ 5   → rightOffset = 5  (always some breathing room)
  //   total labels 6-10  → rightOffset = 8
  //   total labels 11-15 → rightOffset = 12
  //   total labels 16+   → rightOffset = 16 (cap, sinon la timeline devient trop tassée)
  const total = opts.priceOverlayLineCount + opts.priceLineCount;
  if (total <= 5) return 5;
  if (total <= 10) return 8;
  if (total <= 15) return 12;
  return 16;
}
```

Le calcul vit dans `chartBootstrap.applyRightOffset(chart, allIndicators)` invoqué **après** que tous les indicateurs soient appliqués. Frontend ET backend invoquent.

**Test visuel obligatoire** : snapshots à 3 densités (1 indicateur, 5 indicateurs, 11 indicateurs all-active) — assert que la dernière candle (right-most) est visible sur les 3 (pas overlap sur ses pixels par les labels). Tests dans `test/parity/chart-visibility.test.ts`.

### 4.6 React adapter

`src/client/components/charts/TradingViewChart.tsx` — composant React principal :

```tsx
type Props = {
  candles: Candle[];
  /** Indicator configs to render (computed contributions). Empty = naked. */
  indicators?: Array<{
    id: string;
    plugin: IndicatorPlugin;   // resolved by caller via registry
    contribution: IndicatorSeriesContribution;
  }>;
  /** Static price lines (Entry/SL/TP overlay) — independent of indicators. */
  priceLines?: Array<{ price: number; color: string; label: string; style?: 0 | 1 | 2 }>;
  /** Event markers (replay only). */
  markers?: Array<{ time: UTCTimestamp; ... }>;
  /**
   * Show the indicator toggle panel built into the framework. When true,
   * the user can hide/show any indicator passed in `indicators` via
   * checkboxes/chips. State lives inside the component — caller doesn't
   * manage it. Default false (chart is read-only).
   *
   * IMPORTANT : has no effect on the backend Playwright render path.
   * That path always renders every indicator from the watch config.
   */
  enableControls?: boolean;
  /**
   * Initial visibility per indicator (only when `enableControls`).
   * Default: all visible. Use to opt-out by default ("show nothing,
   * user reveals one by one") for crowded charts.
   */
  initialVisibility?: Record<string, boolean>;
  /** Layout config for the controls panel. */
  controlsLayout?: 'top-chips' | 'sidebar-right' | 'sidebar-left';
  /** Resize / fullscreen wiring. */
  containerClassName?: string;
  enableFullscreen?: boolean;
  onChartReady?(chart: IChartApi): void;
};
```

Trois call-sites remplacés :
- `replay-chart.tsx` → wrapper qui passe `indicators`, `priceLines`, `markers` ; **active `enableControls`** ; `initialVisibility={{}}` (tout masqué par défaut, l'utilisateur révèle au besoin — comportement actuel)
- `tv-chart.tsx` → wrapper qui passe `priceLines` seulement (Entry/SL/TP/Invalidation). `enableControls={false}` car la page setup montre toujours le même indicateur set (rien à toggler)
- `asset-chart.tsx` → wrapper qui passe `candles` + volume built-in. `enableControls={false}` car la page browse asset ne configure pas d'indicateurs

Le ResizeObserver, fullscreen handler, scroll-position remember vivent **dans `TradingViewChart`**. Les wrappers fournissent juste la data.

### 4.6bis Indicator controls UI (panel intégré)

Quand `enableControls` est `true`, `<TradingViewChart>` rend en plus un panneau de contrôles. Sous-composant interne :

```tsx
function IndicatorControlPanel(props: {
  indicators: IndicatorPlugin[];   // accessible via props.indicators[].plugin
  visibility: Record<string, boolean>;
  onToggle: (id: string, visible: boolean) => void;
  onShowAll(): void;
  onShowNone(): void;
  layout: 'top-chips' | 'sidebar-right' | 'sidebar-left';
}): JSX.Element;
```

Sources de vérité **dans** `TradingViewChart` :
- State `visibility: Record<string, boolean>` initialisé depuis `initialVisibility` ou `{ ...all: true }`
- Un useEffect qui, à chaque change de `visibility`, **rebuild les indicateurs visibles** sur le chart (cleanup + reapply)
- Le caller ne sait rien du visibility state — c'est interne au framework

Le pattern actuel (state dans `replay-session.tsx` + composant `IndicatorToggles` séparé + prop drilling) **disparaît**. Le caller passe seulement la liste complète d'indicators ; le framework décide ce qui est visible.

**Variante d'affichage** :
- `top-chips` (default) : chips horizontaux au-dessus du chart, type tags toggleable (cohérent avec l'UI actuelle de replay)
- `sidebar-right` / `sidebar-left` : panneau vertical à droite/gauche du chart, pour les charts pleine page

### 4.6ter Pane management déterministe

Pour les indicateurs `renderConfig.pane === "secondary"` (RSI, MACD, ATR, Volume), chacun obtient une **pane lightweight-charts dédiée**. L'ordre des panes est déterministe :
1. Pane 0 : main candle pane (toujours)
2. Pane 1+ : indicateurs `secondary` dans l'ordre de la prop `indicators[]`, **filtré sur visibility**

```ts
// Pseudo-code dans applyIndicators()
let nextPaneIndex = 1;
const paneAssignments = new Map<string, number>();
for (const ind of indicators) {
  if (!visibility[ind.id]) continue;  // skip hidden
  if (ind.plugin.renderConfig.pane === 'secondary') {
    paneAssignments.set(ind.id, nextPaneIndex++);
  } else {
    paneAssignments.set(ind.id, 0);
  }
}

// Apply stretch factors
for (const [id, paneIdx] of paneAssignments) {
  if (paneIdx === 0) continue;
  const stretch = pluginById(id).renderConfig.secondaryPaneStretch ?? 13;
  chart.panes()[paneIdx]?.setStretchFactor(stretch);
}
chart.panes()[0]?.setStretchFactor(50);  // main pane gets the most space
```

**Conséquences** :
- **Toggle visibility d'un indicateur secondary fait disparaître sa pane** (cleanup → reapply rebuilds pane allocation). Pas de "pane vide qui reste".
- **L'ordre dans la prop `indicators[]` détermine l'ordre vertical des panes** (caller-controlled, prévisible).
- **Le total des stretch factors détermine les proportions** : main=50, RSI=13, ATR=13 → main occupe 50/76 = 66% de la hauteur, RSI 17%, ATR 17%.
- **`computeRightOffset` (Goal #5) intègre la densité par pane** : un chart avec 3 panes secondaires + 6 indicateurs price_overlay calcule un offset basé sur la pane main (où les labels overlapent), pas sur les panes secondaires (où les labels n'overlap pas de la même façon).

Open question §8 #8 (nouvelle) : la même pane peut-elle héberger plusieurs indicateurs secondary (e.g. RSI + Stochastic) si on veut économiser de la place verticale ? Pour cette spec : **non**, 1 indicateur secondary = 1 pane. Si futur besoin : `renderConfig.sharedPaneGroup?: string` permettrait de regrouper.

### 4.7 Playwright adapter

`src/adapters/chart/PlaywrightChartRenderer.ts` (refacto) :

```ts
async warmUp() {
  // 1. Launch Chromium
  // 2. Build the page template ONCE :
  //    - <head> : lightweight-charts.standalone.production.js (inline)
  //    - <head> : contributionRenderer.ts + chartBootstrap.ts transpiled to JS
  //              via Bun.Transpiler.transformSync, injected as <script>.
  //              Exposes window.__tradingFlowChart = { render(args) }
  //    - <body> : <div id="chart"></div>
  // 3. Pre-create pages from this template (pool).
}

async render({ candles, indicators, enabledIds, width, height, ... }) {
  // 1. setViewportSize
  // 2. setContent(templateHtml)
  // 3. page.evaluate(args => window.__tradingFlowChart.render(args), { candles, indicators })
  //    where `indicators` is the SAME shape as the React Props
  // 4. screenshot → resize → WebP → return
}
```

Le `window.__tradingFlowChart.render(args)` côté page Playwright :

```ts
function render(args) {
  // Same code as TradingViewChart but in vanilla DOM, not React.
  const { chart, candleSeries } = createTradingViewChart(container, opts);
  candleSeries.setData(args.candles);
  for (const ind of args.indicators) {
    applyContribution(chart, ind.contribution, {
      id: ind.id,
      renderConfig: ind.renderConfig,  // included in payload
      candleTimes,
      mainSeries: candleSeries,
      markerBucket,
    });
  }
  // ... apply priceLines, markers, etc.
  chart.timeScale().fitContent();
  window.__chartReady = true;
}
```

→ Le **même TS** drive le rendu dans les deux contextes. Single source of truth.

### 4.8 Loading on-demand

L'enregistrement statique reste pour la lisibilité, mais le contract permet le lazy :

```ts
// Static (current pattern, kept for backward compat)
export const INDICATOR_PLUGINS: ReadonlyArray<IndicatorPlugin> = [
  emaStackPlugin, rsiPlugin, /* ... */
];

// Dynamic (optional, used by Playwright for narrow watches)
export async function loadPlugin(id: string): Promise<IndicatorPlugin> {
  const mod = await import(`./plugins/${id}/index.ts`);
  return mod.default;
}
```

**Frontend** : pour l'instant, tous les plugins sont bundled (Bun gère bien le code splitting si on veut activer plus tard). Pas de gain immédiat avec 11 plugins.

**Backend** : `PlaywrightChartRenderer.render(args)` ne charge que les plugins listés dans `args.enabledIds`. Les payloads `indicators` passés contiennent déjà `renderConfig`, donc la page Playwright n'a besoin de rien d'autre. **Le bundle injecté dans la page reste statique** (contributionRenderer + chartBootstrap) — c'est juste l'invocation qui est sélective.

Pour 50+ plugins futurs, on activera le code splitting Bun via dynamic imports. Le contract le permet déjà.

### 4.9 Storybook validation harness

**Storybook 10.4** (latest stable au moment de la rédaction, released 2026-05-14) est ajouté au projet comme **golden path de validation visuelle** du framework chart. Chaque API publique a une story qui démontre son usage. Les stories sont des fixtures déterministes (mêmes inputs → même rendu pixel-stable), utilisables aussi par les tests backend.

#### Setup

Init dans un projet Bun existant (Storybook ne détecte pas Bun automatiquement) :

```sh
bunx storybook@latest init --skip-install --package-manager bun
bun install
```

Builder : **`@storybook/react-vite`** (Vite est ajouté comme dev-only ; ne conflit pas avec `Bun.serve` en prod — Vite ne sert QUE Storybook, jamais l'app principale).

`.storybook/main.ts` :

```ts
import type { StorybookConfig } from "@storybook/react-vite";
import tsconfigPaths from "vite-tsconfig-paths";
import tailwind from "@tailwindcss/vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    "@storybook/addon-vitest",   // remplace test-runner en v10
  ],
  framework: { name: "@storybook/react-vite", options: {} },
  viteFinal: (cfg) => {
    cfg.plugins = [...(cfg.plugins ?? []), tsconfigPaths(), tailwind()];
    return cfg;
  },
};
export default config;
```

`.storybook/preview.tsx` :

```tsx
import "@client/lib/setupLightweightChartsGlobal";  // expose window.LightweightCharts
import "../src/client/globals.css";                // Tailwind v4 entry
import type { Preview } from "@storybook/react-vite";

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i } },
    backgrounds: { default: "trading", values: [{ name: "trading", value: "#131722" }] },
    viewport: {
      defaultViewport: "chartLg",
      viewports: {
        chartLg: { name: "Chart 1280×720", styles: { width: "1280px", height: "720px" } },
        chartSm: { name: "Chart 800×400", styles: { width: "800px", height: "400px" } },
      },
    },
  },
  decorators: [
    // lightweight-charts mesure son container sur mount. Sans dimensions
    // explicites, l'iframe Storybook commence à 0×0 → chart ne paint pas →
    // screenshot vide. Wrapper qui force min-size.
    (Story) => (
      <div style={{ width: 1024, height: 600 }}>
        <Story />
      </div>
    ),
  ],
};
export default preview;
```

#### Story coverage requirements

**Toute API publique du framework a au moins une story**. Liste minimale :

```
src/client/components/charts/__stories__/
├── TradingViewChart.stories.tsx       # composant principal — 6+ stories
│   ├── Naked                          # 0 indicateur
│   ├── SingleIndicator (RSI)          # 1 indicateur secondary
│   ├── PriceOverlayStack              # 5 indicateurs price_overlay (EMA + BB)
│   ├── HighDensity                    # 11 indicateurs all-active — test rightOffset
│   ├── WithControls                   # enableControls + initialVisibility={{}}
│   └── WithPriceLines                 # Entry/SL/TP (clone du tv-chart use case)
├── BandsPrimitive.stories.tsx         # bands seules, 3 configs (uptrend / downtrend / no anchor)
└── ControlPanel.stories.tsx           # IndicatorControlPanel isolé, layouts top-chips / sidebar

src/adapters/indicators/plugins/*/   # une story par plugin
├── ema_stack/__stories__/EmaStack.stories.tsx     # default + custom periods
├── rsi/__stories__/Rsi.stories.tsx
├── fibonacci/__stories__/Fibonacci.stories.tsx    # uptrend, downtrend, no-anchor
└── ...
```

Format de story canonique :

```tsx
import { TradingViewChart } from "../TradingViewChart";
import { fibonacciPlugin } from "@adapters/indicators/plugins/fibonacci";
import { rsiPlugin } from "@adapters/indicators/plugins/rsi";
import fixtureBullish from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";

export default {
  title: "Charts/TradingViewChart",
  component: TradingViewChart,
};

export const HighDensity = {
  args: {
    candles: fixtureBullish,
    indicators: [
      { id: "ema_stack", plugin: emaStackPlugin, contribution: emaStackPlugin.compute(fixtureBullish, emaStackPlugin.defaultParams) },
      { id: "bollinger", plugin: bollingerPlugin, contribution: bollingerPlugin.compute(fixtureBullish, bollingerPlugin.defaultParams) },
      { id: "rsi", plugin: rsiPlugin, contribution: rsiPlugin.compute(fixtureBullish, rsiPlugin.defaultParams) },
      { id: "fibonacci", plugin: fibonacciPlugin, contribution: fibonacciPlugin.compute(fixtureBullish, fibonacciPlugin.defaultParams) },
      // ... all 11
    ],
    enableControls: false,
  },
};
```

#### Interaction tests dans les stories

Pour les comportements (toggle visibility, fullscreen, resize), utiliser `storybook/test` (v10 import path) :

```tsx
import { expect, fn, userEvent, within, waitFor } from "storybook/test";

export const ToggleHidesPane = {
  args: { ...HighDensity.args, enableControls: true, initialVisibility: { rsi: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // chart needs a tick to mount → findBy* awaits
    await canvas.findByTestId("trading-view-chart");
    await waitFor(() => expect(canvas.getByTestId("pane-rsi")).toBeVisible());
    await userEvent.click(canvas.getByRole("checkbox", { name: /rsi/i }));
    await waitFor(() => expect(canvas.queryByTestId("pane-rsi")).toBeNull());
  },
};
```

#### Workflow dev

1. **Phase 1-3 du refacto** : pour chaque composant créé, écrire la story d'abord (TDD). Lancer `bun run storybook` (port 6006).
2. **Validation visuelle** via Chrome DevTools MCP : `navigate_page` vers `http://localhost:6006/iframe.html?id=<story-id>` → `take_screenshot`. Inspection humaine du PNG.
3. **Si la story rend correctement** → écrire le test backend correspondant (cf. §6.X) qui appelle `PlaywrightChartRenderer.render({ candles, indicators })` avec EXACTEMENT la même config + asserts SHA256 du webp. Si visuellement OK frontend → webp valide backend.
4. **Le bundle test** : les fixtures `@test-fixtures/candles/*.json` sont partagées entre stories (frontend) et backend tests.

#### Visual regression locale (sans Chromatic)

v10 a supersédé `@storybook/test-runner` par `@storybook/addon-vitest`. Pas de pixel-diff built-in (Chromatic est le path officiel mais payant). **Notre approche** :
- Chrome DevTools MCP pour les captures manuelles pendant le dev (déjà utilisé pour les autres screenshots)
- `bun run storybook build` → `storybook-static/` → CI peut le servir + un script Playwright qui itère sur toutes les stories, screenshote, et compare aux baselines `test/fixtures/story-baselines/*.png` via `pixelmatch` (lib NPM standard, ~10KB).
- Pas de hard pixel-diff, tolerance ~2% (anti-aliasing, sub-pixel font rendering).

#### Pourquoi Storybook plutôt qu'une autre approche

| Alternative | Pourquoi pas |
|---|---|
| **Tests Playwright pure** sur l'app principale | L'app a beaucoup de routes ; coupler les chart-tests aux routes mélange concerns. Storybook isole chaque composant en iframe minimaliste, plus rapide à itérer. |
| **Tests unitaires DOM avec jsdom** | Lightweight-charts a besoin d'un vrai canvas. Jsdom n'en a pas. Storybook iframe = vrai navigateur. |
| **Pas de validation visuelle, juste tests fonctionnels** | Les bugs visuels (couleurs, overlap labels, panes mal allouées) ne sont PAS détectables par tests fonctionnels seuls. Storybook permet de **voir** rapidement. |
| **`@storybook/test-runner` au lieu de `addon-vitest`** | v10 a déprécié test-runner en faveur de l'addon vitest, qui mutualise interaction/a11y/(visual via Chromatic) en un seul moteur. |

#### Risques propres à Storybook

| # | Risque | Mitigation |
|---|---|---|
| S1 | Lightweight-charts ne paint pas dans iframe Storybook (container `0×0` au mount) | Décorateur global qui force `width: 1024, height: 600` (cf. preview.tsx ci-dessus). Ne pas oublier le `width: 100%` interne du composant. |
| S2 | Tailwind v4 cassé dans Storybook (différent path que main app) | `@tailwindcss/vite` plugin dans `viteFinal`. Préviewer un composant avec classes Tailwind dès Phase 1 pour valider. |
| S3 | Path aliases TS (`@adapters/*`, `@client/*`) non résolus | `vite-tsconfig-paths` plugin dans `viteFinal`. Source unique = `tsconfig.json`. |
| S4 | Bun + Storybook : Vite résout JSX en mode monorepo de manière instable (oven-sh/bun#12148) | Single-package repo (notre cas) : pas concerné. À surveiller si on splitte en workspaces plus tard. |
| S5 | Stories deviennent stale vs framework | Lint custom : pour chaque plugin sous `src/adapters/indicators/plugins/*/index.ts`, exiger une story `__stories__/*.stories.tsx` dans le même répertoire. CI check. |

## 5. Migration strategy

Sept phases, chaque phase est mergeable et déployable indépendamment. **Aucune phase ne casse l'existant tant que la suivante n'est pas en place.**

### Phase 0 — Setup Storybook (no app change)

- `bunx storybook@latest init --skip-install --package-manager bun` + `bun install`
- Écrire `.storybook/main.ts`, `.storybook/preview.tsx` (cf. §4.9)
- `bun add -D vite-tsconfig-paths @tailwindcss/vite @storybook/addon-vitest pixelmatch`
- Une story de validation initiale : `__stories__/Smoke.stories.tsx` qui rend un `lightweight-charts.createChart(container)` minimal avec 50 candles. Boot OK = setup OK.
- Test : `bun run storybook` lance sur :6006, le smoke story affiche un chart vert.
- Commit + push.

### Phase 1 — Foundation (no breaking change)

- Créer `src/domain/charts/types.ts` (IndicatorSeriesContribution déplacé ici depuis `adapters/indicators/plugins/base/types.ts`, re-exporté pour backward compat)
- Créer `src/adapters/chart/contributionRenderer.ts` (le dispatcher unifié)
- Créer `src/adapters/chart/chartBootstrap.ts` (le bootstrap unifié + `applyRightOffset`)
- Créer `src/adapters/chart/bandsPrimitive.ts` (la primitive canvas pour `kind: "bands"`)
- Créer `src/adapters/chart/paneAllocator.ts` (pure TS, déterministe)
- Créer `src/client/lib/setupLightweightChartsGlobal.ts` (expose `window.LightweightCharts`)
- **Storybook coverage** : pour chaque nouveau module, une story isolée (`__stories__/BandsPrimitive.stories.tsx` etc.) qui démontre le rendu. Validation visuelle via Chrome DevTools MCP avant merge.
- Unit tests : dispatch sur chaque kind avec un fake chart
- Test visuel `BandsPrimitive` : story + screenshot avec 4 bands sur fixture connue, assert SHA et présence visuelle des rectangles
- Test rightOffset : stories à 1 / 5 / 11 indicateurs, assert que les dernières candles ne sont jamais masquées (pixel-check sur la colonne droite)
- **Aucun call-site existant ne change**

### Phase 2 — React adapter

- Créer `src/client/components/charts/TradingViewChart.tsx`
- Couvre tous les besoins de `replay-chart.tsx` (le plus riche)
- Tests : snapshots Playwright sur un fixture déterministe (mêmes candles + indicateurs)

### Phase 3 — Migrer le frontend (3 sites, séquentiel)

- 3a. Migrer `replay-chart.tsx` → wrapper de `<TradingViewChart enableControls>`. **Supprimer en même temps** :
  - `src/client/components/replay/indicator-toggles.tsx` (remplacé par le panel intégré au framework)
  - Le state `visibleIndicatorIds` + `setVisibleIndicatorIds` + `setupFocusTouchedRef` dans `replay-session.tsx` (le visibility state vit maintenant dans `TradingViewChart`)
  - Le wrapper passe juste `indicators={[...]}`, `enableControls`, `initialVisibility={{}}` (l'ergonomie "tout caché par défaut" est préservée).
  - Vérifier visuellement la parité sur 1-2 sessions replay.
- 3b. Migrer `setup/tv-chart.tsx` → wrapper minimal (juste candles + priceLines, `enableControls={false}`).
- 3c. Migrer `asset/asset-chart.tsx` → wrapper (candles + volume comme indicateur ou hard-coded selon discussion, `enableControls={false}`).
- Test parity : screenshots avant/après pour chaque page.

### Phase 4 — Plugin contract migration (mécanique, plugin par plugin)

Pour CHAQUE plugin (ema_stack, rsi, ...) :
- Ajouter `renderConfig: {...}` dans le plugin (extrait des couleurs hardcodées du chartScript)
- Le chartScript existant **reste pour l'instant** (utilisé par PlaywrightChartRenderer ancien)
- Test plugin : `compute(fixture) → contribution` reste identique (parity test compute)

### Phase 5 — Playwright adapter refacto

- Refacto `PlaywrightChartRenderer.warmUp` pour injecter `contributionRenderer` + `chartBootstrap` (transpilation Bun.Transpiler au warm-up)
- Refacto `chart-template.html` pour exposer `window.__tradingFlowChart.render(args)` qui utilise les nouveaux modules
- Nouvelle signature de `render()` : accepte `indicators[]` avec `renderConfig` inclus dans le payload
- **Avec un flag d'env** `USE_NEW_CHART_RENDERER=1` pour switch entre ancien et nouveau. Tests parity image (pixel-diff tolerance) avant de drop l'ancien.

### Phase 6 — Cleanup

- Supprimer `chartScript.ts` de chaque plugin (plus utilisé)
- Supprimer `chart-template.html` ancien
- Supprimer `src/client/components/replay/PriceBandsOverlay.tsx` (remplacé par `BandsPrimitive` canvas — bands désormais visibles côté frontend ET backend)
- Supprimer l'ancien dispatcher inline dans `applyIndicatorToChart.ts` (devient pure ré-export du nouveau)
- **Bump prompt version detector → `detector_v10`** : l'image LLM inclut maintenant les bandes Fib en couleur (invisible jusque-là côté backend). C'est un changement sémantique visible par le LLM → cache miss délibéré sur tous les detectors pour re-évaluation. Coût attendu : un re-fill du cache LLM (~$0.5/tick × N detectors actifs pendant 24-48h). Compensé par l'amélioration du signal (le LLM voit enfin la golden zone Fib).

**Total estimé** : 8-12h de dev répartis sur les 6 phases, chaque phase est mergeable indépendamment.

## 6. Tests strategy

### 6.1 Tests unitaires

- **Plugin compute** : 1 test par plugin, fixtures déterministes. *(déjà présent, ne change pas)*
- **`contributionRenderer.applyContribution`** : faux chart (mocks `addSeries`, `createPriceLine`, `panes`) + chaque kind testé indépendamment. ~10 tests.
- **`chartBootstrap.createTradingViewChart`** : mock createChart, vérifier que les bonnes options sont passées.

### 6.2 Tests parity (cross-context)

Pour chaque plugin, un test qui :
1. Calcule la contribution sur un fixture candles
2. Applique la contribution sur un faux chart frontend (mock) — capture les calls
3. Applique la contribution sur un faux chart backend (même mock) — capture les calls
4. Assert que les listes de calls sont IDENTIQUES

Garantit que les 2 contextes émettent la même séquence d'appels lightweight-charts.

### 6.3 Tests visuels

- **Frontend** : Playwright screenshot sur des routes-clés (`/replay/:id`, `/setups/:id`, `/asset/:source/:symbol`) avec data déterministe (fixtures mocked API). Pixel diff tolerance 1-2% (couleurs anti-aliasing fluctuent).
- **Backend** : `PlaywrightChartRenderer.render(fixture)` → SHA256 de l'image. Stocker les SHA de référence dans `test/fixtures/chart-screenshots/`. CI flag si change.

### 6.4 Tests visibilité bougies (rightOffset)

Test critique : sur 3 fixtures `low-density (1 indicateur)`, `medium-density (5 indicateurs)`, `high-density (11 indicateurs all-active)` :
1. Render le chart à dimension cible (1280×720)
2. Inspecter le buffer pixel : pour la colonne x = right_edge - 10px (juste à gauche des labels), vérifier que la couleur dominante est PAS la couleur des labels (#d1d4dc gris) mais bien soit candle-up (#26a69a) soit candle-down (#ef5350) ou background (#131722). Assert présence d'au moins 5 pixels candle-color.
3. Si fail → les labels masquent les bougies → ajuster le palier de `computeRightOffset`.

Fait à la fois frontend (Playwright sur route React) et backend (PlaywrightChartRenderer direct).

### 6.5 Tests visuels bands primitive (Fibonacci)

- Fixture : 200 candles bullish avec swing pair connu.
- Render avec Fib activé → screenshot.
- Assert : présence pixel des bandes (couleur rgba semi-transparente entre 2 niveaux Fib calculés). 4 bandes attendues (golden zone, mid, shallow, deep).
- Frontend ET backend — la primitive doit produire un rendu identique (pixel-diff < 1%) puisque le canvas est le même mécanisme.

### 6.6 Test "drift detection" pour usage futur

Pattern partagé : un test E2E qui (a) lance un tick complet sur fixture, (b) screenshote le chart frontend pour le même tickSnapshot, (c) screenshote le chart backend pour le même tickSnapshot, (d) assert pixel-diff < tolerance. Le seul test qui chante quand le frontend et le backend divergent. À ajouter en Phase 5.

## 7. Risques + mitigations

| # | Risque | Probabilité | Mitigation |
|---|---|---|---|
| 1 | **Cache LLM invalidé sciemment** par l'ajout des bands Fib sur l'image → coût LLM × N pendant 24-48h jusqu'à re-cache | Certaine (acté) | Bump `detector_v10`. Planifier dans une fenêtre creuse forex (weekend ou nuit US). Communiquer l'attente du coût ponctuel. |
| 2 | **Régression LLM sémantique** : le LLM raisonne différemment sur la nouvelle image (bands visibles → influencent verdicts) | Moyenne (effet attendu) | C'est désiré : on veut que le LLM utilise les bands. Mais surveiller le rate de Strengthen/Weaken sur les 7 premiers jours post-deploy ; si bias massif, ajuster le prompt detector_v10. |
| 3 | **TS → JS transpilation au warm-up** échoue silencieusement (Bun.Transpiler change de comportement) | Faible | Test : au warm-up, eval le bundle transpilé sur une page Playwright et assert que `window.__tradingFlowChart.render` est défini. Throw early sinon. |
| 4 | **`globalThis.LightweightCharts` undefined** côté frontend si import oublié | Moyenne | `contributionRenderer` throw explicitement avec un message qui pointe vers `setupLightweightChartsGlobal.ts`. CI ESLint rule : interdire l'import direct de `lightweight-charts` constants hors de `chartBootstrap.ts` et `setupLightweightChartsGlobal.ts`. |
| 5 | **`ISeriesPrimitive` API** moins documentée / cassée en v5 | Moyenne | Prototype Phase 1 standalone (`BandsPrimitive` testée en isolation sur un chart minimal AVANT d'intégrer au dispatcher). Si l'API ne fait pas le job (z-order, time-axis coordinate, etc.), fallback : un canvas overlay 2D positionné en absolu au-dessus du chart canvas, dessiné synchronously sur events (ResizeObserver + subscribeVisibleTimeRangeChange). Plus de code mais cross-context-portable. |
| 6 | **`computeRightOffset` mal calibré** : trop petit → labels overlap candles ; trop grand → trop de vide à droite, candles tassées | Élevée | Tests pixel §6.4 sur 3 densités, calibration empirique. Si pas trivial, exposer un override prop `rightOffsetOverride?: number` pour cas-par-cas. |
| 7 | **Vendor drift lightweight-charts v5 → v6** : breaking API change | Faible (lockfile pin) | Pin la version dans package.json. Migration via une nouvelle phase si v6 sort. |
| 8 | **PR géante difficile à reviewer** | Élevée | Strict 6-phase split. Chaque phase mergee + déployée indépendamment. |

## 8. Open questions

1. **Asset chart : indicateur volume ou hard-coded ?**  
   Le volume sur `asset-chart.tsx` est hard-codé (histogram secondaire). Faut-il en faire un "indicateur" formel ? L'avantage : un seul code path. L'inconvénient : le volume n'est pas configurable comme les autres (params, scaling, etc.). **Proposition** : le rendre un indicateur formel `volume_simple` avec config minimale, ou garder `<TradingViewChart>` qui accepte un prop `showVolume?: boolean` qui injecte un indicateur built-in.

2. **PriceLinesOverlay (Entry/SL/TP) : indicateur ou prop séparée ?**  
   Sur `replay-chart`, les priceLines des setups sont gérées en parallèle des indicateurs. Faut-il les unifier ? **Proposition** : prop `priceLines` séparée — c'est une UI feature qui ne sort jamais du domain "indicateur".

3. **Fullscreen + ResizeObserver : dans `<TradingViewChart>` ou dans le wrapper ?**  
   Replay a fullscreen, les autres pas. **Proposition** : dans `<TradingViewChart>` avec un prop `enableFullscreen?: boolean` (default true). Le wrapper minimal le désactive si non voulu.

4. **Markers depuis indicators vs depuis events : conflit de bucket ?**  
   Sur replay, les `Swing H/L` markers de Fibonacci + les markers d'events (`SetupCreated`, `Strengthened`) doivent coexister. **Proposition** : `<TradingViewChart>` expose un `markerBucket` interne qui combine indicator markers + caller-supplied markers et commit en un seul `createSeriesMarkers()`.

5. **`renderConfig.palette` : statique ou dynamique selon nb de setups (replay) ?**  
   Sur replay, `colorForSetup(setupId)` génère une couleur par setup. C'est OUT of plugin scope (c'est une couleur d'événement, pas d'indicateur). **Proposition** : le caller passe ces colors via `priceLines` / `markers` props, indépendants du `renderConfig` plugin.

6. **Backward compat avec `IndicatorPluginMetadata` (existant) ?**  
   Le metadata est partagé avec le watch-form UI (`section-indicators.tsx`). On garde la structure existante, on ajoute juste `renderConfig` au plugin. **Proposition** : non-breaking ; les anciens callers (form UI) ne lisent pas `renderConfig`, le nouveau renderer en a besoin.

7. **Faut-il aussi unifier les markers / labels de prompts (`getPromptData`) ?**  
   Hors-scope cette spec — le prompting est déjà unifié via `getPromptData` + `IndicatorFragmentFormatter`. Mention pour info.

## 9. Decision log

Tranché le 2026-05-18 (en clôture de la phase de brainstorm, avant
génération du plan d'implémentation).

### D1 — Volume = indicateur formel, asset-chart consomme le pipeline plugin (résout Q1)

Le plugin `volume` existe déjà (`src/adapters/indicators/plugins/volume/`,
métadonnée dans `src/shared/indicatorMetadata.ts`). Aujourd'hui `asset-chart.tsx`
l'ignore et fait son propre `chart.addSeries(HistogramSeries)` hard-codé.

**Décision** : asset-chart passe par le pipeline plugin standard. Volume reste
activable / désactivable via la watch config (default disabled, opt-in
utilisateur — pas de `defaultEnabled: true`).

**Conséquence sur la refacto** : asset-chart devient un wrapper qui utilise
`<TradingViewChart watchConfig={...} />` — si l'utilisateur a activé le volume
dans la watch config, il s'affiche ; sinon non. Aucune exception au pipeline.

**Principe général dérivé** : `<TradingViewChart>` expose une **API riche par
props** (sauvegardé en memory : `feedback_chart_framework_props`). Quand un
besoin n'est pas couvert par les métadonnées plugin (ex: forcer un affichage
contextuel), c'est une prop sur le composant, pas une extension du plugin.

### D2 — PriceLines de setup via prop dédiée (résout Q2)

`<TradingViewChart priceLines={[{price, color, title, style}]} />`. Les Entry /
SL / TP / autres niveaux business ne passent **pas** par le pipeline plugin.
Justification : ce sont des événements pipeline (issus de `setups.keyLevels`),
pas des indicateurs TA calculés depuis les chandelles.

### D3 — Fullscreen dans le composant, opt-in par prop (résout Q3)

`enableFullscreen?: boolean` sur `<TradingViewChart>`. F11 toggle automatique
quand `true`. Chaque contexte configure :
- **Replay** : `enableFullscreen={true}`
- **Asset-chart** : `enableFullscreen={false}` (vue compacte)
- **Setup detail (`tv-chart`)** : `enableFullscreen={true}` (utile pour analyse)
- **Backend Playwright** : non concerné par cette prop — `PlaywrightChartRenderer`
  rend toujours à une grande résolution fixe définie dans
  `chart-template.html` (cf. §4.7).

### D4 — Marker bucket interne au composant (résout Q4)

`<TradingViewChart>` collecte les markers émis par les indicateurs activés
(via `IndicatorSeriesContribution kind="markers"`) + ceux passés en prop
`markers={[...]}` par le caller, les fusionne, et fait **un seul** appel
`createSeriesMarkers(candleSeries, [...])`. Le caller n'a pas à connaître la
contrainte LC v5 (createSeriesMarkers remplace tout à chaque appel).

### D5 — Couleurs setup côté caller, framework agnostique (résout Q5)

`<TradingViewChart>` n'a aucune notion de "setup". Le caller (replay-chart)
passe `colorForSetup(setupId)` directement dans les props `priceLines` et
`markers`. Le framework ne connaît que des `{price, color}` ou
`{time, color}`.

### D6 — `renderConfig` sur le plugin, non-breaking (résout Q6)

Le plugin gagne un champ `renderConfig: { palette, seriesLabels, styles, ... }`
consommé par le nouveau dispatcher. Le metadata existant
(`IndicatorPluginMetadata` dans `src/shared/indicatorMetadata.ts`) reste tel
quel — le watch-form UI continue de lire les anciens champs sans toucher
`renderConfig`. Non-breaking, deux audiences distinctes.

### D7 — Circuit prompt hors-scope (résout Q7)

`getPromptData()` + `promptFragments.ts` (par plugin) + `IndicatorFragmentFormatter`
restent **intacts**. La refacto touche uniquement le circuit image (chart
rendering). Si un jour on veut harmoniser labels texte ↔ image, ce sera une
spec dédiée.

**Conséquence sur la structure plugin après refacto** :
```
src/adapters/indicators/plugins/fibonacci/
├── index.ts             # + renderConfig ajouté dans l'objet plugin
├── compute.ts           # inchangé
├── promptFragments.ts   # INCHANGÉ — circuit 2 intact
└── chartScript.ts       # SUPPRIMÉ — remplacé par renderConfig + dispatcher
```

### D8 — Palette de couleurs : chaque plugin self-contained (résout Q-bonus)

Pas de fichier central `src/domain/charts/palette.ts`. Chaque plugin déclare
ses couleurs **dans son propre `renderConfig.palette: string[]`**. Plus
modulaire et cohérent avec l'architecture plugin (un plugin est une unité
auto-portante). Single source of truth = le plugin lui-même.

**Conséquence sur §10** : retirer `src/domain/charts/palette.ts` de la liste
des fichiers créés.

## 10. Annexe — référence aux fichiers existants à toucher

### Fichiers créés (nouveaux)

**Framework chart** :
- `src/domain/charts/types.ts` *(IndicatorSeriesContribution déplacé)*
- `src/adapters/chart/contributionRenderer.ts`
- `src/adapters/chart/chartBootstrap.ts` *(inclut `computeRightOffset` + `applyRightOffset`)*
- `src/adapters/chart/bandsPrimitive.ts` *(ISeriesPrimitive canvas pour bands Fib)*
- `src/adapters/chart/paneAllocator.ts` *(allocation déterministe des panes secondaires + stretch factors)*
- `src/client/lib/setupLightweightChartsGlobal.ts`
- `src/client/components/charts/TradingViewChart.tsx` *(composant principal, gère controls + panes + rendering)*
- `src/client/components/charts/IndicatorControlPanel.tsx` *(sous-composant interne — chips / sidebar)*

**Storybook setup** (Phase 0) :
- `.storybook/main.ts`
- `.storybook/preview.tsx`
- `.storybook/test-runner.ts` *(si on adopte le pixel-diff Playwright)*
- `package.json` scripts : `"storybook": "storybook dev -p 6006"`, `"build-storybook": "storybook build"`

**Stories** (Phase 1+ par composant) :
- `src/client/components/charts/__stories__/TradingViewChart.stories.tsx`
- `src/client/components/charts/__stories__/IndicatorControlPanel.stories.tsx`
- `src/client/components/charts/__stories__/Smoke.stories.tsx` *(Phase 0)*
- `src/adapters/chart/__stories__/BandsPrimitive.stories.tsx`
- `src/adapters/indicators/plugins/<plugin>/__stories__/<Plugin>.stories.tsx` × 11 plugins

**Fixtures partagées** (frontend stories + backend tests) :
- `test/fixtures/candles/btcusdt-1h-bullish-200.json`
- `test/fixtures/candles/btcusdt-1h-bearish-200.json`
- `test/fixtures/candles/eurusd-15m-ranging-300.json`
- `test/fixtures/story-baselines/*.png` *(screenshots de référence pour pixel-diff)*

**Tests unitaires** :
- `test/adapters/chart/contributionRenderer.test.ts`
- `test/adapters/chart/chartBootstrap.test.ts` *(inclut tests `computeRightOffset`)*
- `test/adapters/chart/bandsPrimitive.test.ts` *(unit + snapshot canvas)*
- `test/adapters/chart/paneAllocator.test.ts` *(truth table des allocations)*
- `test/client/components/charts/TradingViewChart.test.tsx` *(toggle behavior, pane disparaît, etc.)*

**Tests parity (cross-context)** :
- `test/parity/contributionParity.test.ts`

**Tests visuels** :
- `test/visual/chart-visibility.test.ts` *(les 3 densités d'indicateurs, pixel-check colonne droite)*
- `test/visual/bands-primitive.test.ts` *(Fib bands frontend + backend pixel parity)*
- `test/visual/story-screenshots.test.ts` *(itère sur toutes les stories, compare aux baselines via pixelmatch)*

**Tests backend webp extraction** :
- `test/adapters/chart/PlaywrightChartRenderer.story-parity.test.ts` *(prend la config args d'une story, appelle render(), assert webp SHA256 — pour chaque story qui a un équivalent backend)*

### Fichiers modifiés
- `src/adapters/chart/PlaywrightChartRenderer.ts` *(refacto Phase 5)*
- `src/adapters/chart/chart-template.html` *(simplifié Phase 5)*
- `src/client/components/replay/replay-chart.tsx` *(wrapper Phase 3a)*
- `src/client/components/setup/tv-chart.tsx` *(wrapper Phase 3b)*
- `src/client/components/asset/asset-chart.tsx` *(wrapper Phase 3c)*
- `src/client/components/replay/applyIndicatorToChart.ts` *(re-export Phase 6)*
- `src/adapters/indicators/plugins/*/index.ts` *(ajouter renderConfig — Phase 4)*
- `src/client/frontend.tsx` *(side-effect import setupLightweightChartsGlobal — Phase 2)*

### Fichiers supprimés
- `src/adapters/indicators/plugins/*/chartScript.ts` (× 11 plugins) *(Phase 6)*
- `src/client/components/replay/PriceBandsOverlay.tsx` *(Phase 6 — remplacé par `BandsPrimitive`)*
- `src/client/components/replay/indicator-toggles.tsx` *(Phase 3a — remplacé par `IndicatorControlPanel` intégré)*
- `src/client/components/replay/chart-legend.tsx` *(Phase 3a — la légende est maintenant rendue par `<TradingViewChart>` lui-même si `enableControls`)*
- `src/client/components/replay/applyIndicatorToChart.ts` *(Phase 6 — devient pur re-export, garder pour stabilité d'import)*

## 11. Self-review (rédacteur)

- ✅ Tous les 5 chemins de rendu identifiés sont couverts par la migration
- ✅ Chaque phase est mergeable indépendamment, pas de PR-géante
- ✅ Le drift bug Fib (cause racine de la spec) est couvert par §6.2 (tests parity)
- ✅ La visibilité des bougies (Goal #5) est explicitement testée (§6.4)
- ✅ Les bands Fib désormais rendues canvas-side dans les 2 contextes (Goal #6, §4.5bis)
- ✅ Les controls d'indicateurs sont built-in au framework (Goal #7, §4.6bis) — pas de duplication chez les callers
- ✅ Le backend reste non-contrôlable par design (Goal #8) — `enableControls` no-op côté Playwright
- ✅ La gestion des panes est déterministe + testable (Goal #9, §4.6ter)
- ✅ La hexagonale est respectée (port `IndicatorPlugin`, adapters par contexte, domain pur)
- ✅ Les risques LLM (cache invalidation actée, sémantique attendue) sont anticipés (§7 #1, #2)
- ✅ Palette tranchée (D8) : pas de fichier central, chaque plugin déclare ses couleurs dans son `renderConfig.palette`. Palette de chandelles (`#26a69a` / `#ef5350`) hardcodée dans `chartBootstrap.ts`, alignée sur lightweight-charts defaults.
- ✅ Volume tranché (D1) : `volume` reste un plugin formel ; asset-chart consomme le pipeline plugin standard (plus de hard-code `addSeries(HistogramSeries)`).
- ✅ PriceLines de setup tranchées (D2) : prop `priceLines` séparée sur `<TradingViewChart>`, pas un plugin synthétique.
- ✅ Fullscreen tranché (D3) : prop `enableFullscreen` (default à choisir par contexte). Backend non concerné.
- ✅ Marker bucket tranché (D4) : interne au composant, merge auto indicators + caller props.
- ✅ Couleurs setup (D5) : caller responsable via props priceLines/markers, framework agnostique.
- ✅ Backward compat metadata (D6) : `renderConfig` ajouté côté plugin, `IndicatorPluginMetadata` (form UI) intact.
- ✅ Prompts hors-scope (D7) : circuit `getPromptData` + `IndicatorFragmentFormatter` intact, seul `chartScript.ts` supprimé par plugin.
- ✅ Storybook 10.4 ajouté comme harness de validation visuelle. Phase 0 ajoutée pour le setup. Toute API publique du framework a une story (§4.9).
- ✅ Stories servent de fixtures partagées avec les tests backend (`PlaywrightChartRenderer.story-parity.test.ts`) — si visuellement OK frontend → webp valide backend.
- ⚠️ Note d'impl : `chartScript.ts` supprimés en Phase 6 — les tests existants qui assertent leur contenu (`fibonacciPlugin.chartScript).toContain('__registerPlugin("fibonacci"')`) doivent être migrés ou supprimés. À détailler dans le plan.
- ⚠️ Note d'impl : la `BandsPrimitive` doit être prototypée Phase 1 standalone pour valider que `ISeriesPrimitive` v5 supporte tous nos besoins (z-order bottom, time-axis lookups, full-width default). Si la primitive ne fait pas le job, fallback canvas overlay (cf. §7 #5).
- ⚠️ Note d'impl : `chart-legend.tsx` supprimé en Phase 3a ; la légende est intégrée à `IndicatorControlPanel` (chaque chip = couleur + label de l'indicateur, double-emploi).
- ⚠️ Note d'impl (Storybook) : pixel-diff via script Playwright local OU captures manuelles Chrome DevTools MCP — commencer manuel, automatiser en Phase 6+ si besoin.

---

**Prochaine étape** : génération du plan d'implémentation TDD via
`superpowers:writing-plans` → `docs/superpowers/plans/2026-05-18-chart-rendering-framework-impl.md`.
8 décisions tranchées au §9, aucune open question bloquante.
