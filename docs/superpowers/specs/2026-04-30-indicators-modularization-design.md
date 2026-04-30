# Indicators modularization — design

Date: 2026-04-30
Status: Draft (awaiting review)

---

## 1. Context & goals

Today, the analysis pipeline (`Detector → Reviewer → Finalizer`) consumes a
**fixed bundle of 28 scalar indicators** plus a fixed set of chart overlays
(EMA stack, VWAP, Bollinger, RSI pane, MACD pane, ATR pane, swing markers,
EQH/EQL liquidity lines, FVG bands, recent high/low). Every watch — same
prompt skeleton, same chart rendering. The dispatcher cannot decline to
inject e.g. RSI on a watch where the user wants pure price-action analysis.

We want to make every indicator **opt-in per watch**, with two driving
intentions:

1. A **naked default** (zero indicators) that produces a *minimal* prompt
   (no scalar values, no per-pattern matrices, no reference tables) and a
   *minimal* chart (candles only — no overlays, no secondary panes, not
   even a volume histogram). The model must rely on pure visual pattern
   recognition. This is the test bed for "creativity vs computation".
2. **Modular composition** : each indicator owns its prompt fragment, its
   scalar schema contribution, its chart rendering script, its breakdown
   axis contribution, and its pre-filter contribution. Adding a new
   indicator should mean writing one self-contained plugin module —
   nothing else.

Both intentions converge on a single architecture: a `IndicatorPlugin`
factory contract, an `IndicatorRegistry`, and prompt/chart **skeletons**
that compose contributions at runtime according to the watch's
`indicators` matrix.

### Non-goals (v1)

- Per-indicator parameter UI (RSI period, BB std-mul, ATR period…). The
  plugin contract reserves a slot for `params` but no UI controls are
  built. v1 ships with the current parameter values frozen as defaults.
- User-authored / marketplace indicators. v1 ships with a closed set of
  12 plugins.
- Migration of existing watches. We "nuke" — see §10.

---

## 2. Architecture overview & data flow

### 2.1 The 12 v1 plugins

Grouped by tag (used in the wizard for sectioning):

```
trend       : ema_stack, vwap
volatility  : bollinger, atr
momentum    : rsi, macd
volume      : volume                 (pane volume + MA20 + percentile + scalars)
structure   : swings_bos, recent_range
liquidity   : liquidity_pools, fvg, poc
```

### 2.2 Data flow

```
Watch config
  └── indicators: { [id]: { enabled: boolean } }   (defaults: all false)
        │
        ▼
IndicatorRegistry.resolveActive(watch.indicators)
        │   → IndicatorPlugin[] (active for this watch, ordered by registry)
        │
        ├──► IndicatorCalculator
        │      • computeScalars(candles): merges plugin contributions into
        │        a Record<string, unknown> validated by the dynamic
        │        IndicatorsSchema for this active set.
        │      • computeSeries(candles): merges plugin contributions into
        │        a IndicatorSeriesContribution map keyed by plugin id.
        │
        ├──► PromptBuilder
        │      • Detector / Reviewer prompts use a SKELETON template and
        │        fill slots with plugin fragments.
        │      • Few-shot examples = 2 generic + ≤3 plugin-contributed.
        │      • Confidence-breakdown spec is composed from active axes.
        │
        ├──► PlaywrightChartRenderer
        │      • chart-template.html is now a SKELETON. All plugin
        │        chartScripts are inlined at warmUp; runtime selects
        │        which to activate via payload.enabledIndicatorIds.
        │      • Pane stretch factors computed dynamically.
        │
        └──► PreFilter
               • Reads the active matrix, skips any criterion whose
                 indicator is off (graceful β degradation).
```

### 2.3 Components untouched by this design

These remain orthogonal flags / pipelines:

- **HTF context** (`analyzers.detector.fetch_higher_timeframe`,
  reviewer's `request_additional: { htfChart: true }`) — feature flag
  separate from the indicator matrix. Contributes the `htf` axis to the
  breakdown when enabled.
- **Funding / OI** — crypto-perp specific, fetched conditionally. Lives
  alongside HTF in its own prompt block.
- **Active lessons** (feedback loop) — orthogonal head-block in all 3
  prompts, untouched.
- **Maturation rule, R:R math, costs, session, fail-closed rules** —
  universal pipeline policies, untouched.

---

## 3. Schemas

### 3.1 `WatchSchema` addition

`src/domain/schemas/WatchesConfig.ts`:

```ts
export const KNOWN_INDICATOR_IDS = [
  "ema_stack", "vwap", "bollinger", "rsi", "macd", "atr", "volume",
  "swings_bos", "recent_range", "liquidity_pools", "fvg", "poc",
] as const;
export type IndicatorId = (typeof KNOWN_INDICATOR_IDS)[number];

const IndicatorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // params: z.record(z.string(), z.unknown()).optional(),  // v2 slot
});

const IndicatorsConfigSchema = z
  .record(z.enum(KNOWN_INDICATOR_IDS), IndicatorConfigSchema)
  .default({});

// Inside WatchSchema:
indicators: IndicatorsConfigSchema,
```

Default: empty object → all indicators implicitly off → naked.

### 3.2 Dynamic `IndicatorsSchema` (LLM scalars)

The 28-field `IndicatorsSchema` shipped today goes away as a *static*
type. In its place:

```ts
// src/domain/schemas/Indicators.ts (new)
export function buildIndicatorsSchema(plugins: IndicatorPlugin[]): z.ZodObject<any> {
  if (plugins.length === 0) return z.object({});
  const shape: z.ZodRawShape = {};
  for (const p of plugins) {
    Object.assign(shape, p.scalarSchemaFragment());
  }
  return z.object(shape).strict();
}

export type IndicatorScalars = Record<string, unknown>;
```

Consumers (prompt builder, persistence) carry the loose
`Record<string, unknown>` and validate/parse via the dynamic schema at the
edges. Each plugin internally narrows its own keys.

### 3.3 Adaptive `ConfidenceBreakdownSchema`

```ts
// Plugin contribution mapping
export type BreakdownAxis = "trigger" | "structure" | "volume" | "htf";

export function buildConfidenceBreakdownSchema(
  plugins: IndicatorPlugin[],
  htfEnabled: boolean,
): z.ZodSchema {
  if (plugins.length === 0) {
    // Naked: single 0-100 score, no axis breakdown
    return z.object({ clarity: z.number().min(0).max(100) });
  }
  const axes = new Set<BreakdownAxis>();
  axes.add("trigger");                       // universal when any plugin active
  for (const p of plugins) for (const a of p.breakdownAxes ?? []) axes.add(a);
  if (htfEnabled) axes.add("htf");
  const shape = Object.fromEntries(
    [...axes].map((a) => [a, z.number().min(0).max(25)]),
  );
  return z.object(shape).strict();
}
```

The detector's output JSON `confidence_breakdown` shape is therefore
**per-watch**. The analysis worker validates `sum(breakdown) ≈ initial_score`
when plugins are active, or reads `clarity` directly in naked mode.

### 3.4 Plugin → axis mapping (v1)

| Plugin | breakdownAxes |
|---|---|
| `ema_stack`, `vwap` | (none — reinforces visual `trigger`) |
| `bollinger`, `atr` | (none — reinforces visual `trigger`) |
| `rsi`, `macd` | (none — reinforces visual `trigger`) |
| `volume` | `volume` |
| `swings_bos`, `liquidity_pools`, `recent_range`, `fvg`, `poc` | `structure` |
| (HTF flag, orthogonal) | `htf` |

Rationale: the breakdown axes are evaluation *categories*. `trigger` is
the only universal axis (always present once any indicator is on). `volume`
and `structure` axes only appear when the corresponding indicator family
is active. `htf` mirrors the existing flag.

### 3.5 Persistence

The `setup_outputs` table stores `confidence_breakdown` as JSONB today —
no SQL migration needed for the shape change. The table `watches`: TBD
in implementation plan whether `WatchConfig` is stored as a typed row or
as a JSON blob; if typed, a Drizzle migration adds `indicators jsonb`.

---

## 4. The `IndicatorPlugin` contract

Located at `src/domain/services/IndicatorPlugin.ts`:

```ts
import type { Candle } from "@domain/schemas/Candle";
import type { IndicatorId } from "@domain/schemas/WatchesConfig";
import type { z } from "zod";

export type IndicatorTag =
  | "trend" | "volatility" | "momentum" | "volume" | "structure" | "liquidity";

export type ChartPaneKind = "price_overlay" | "secondary";
export type BreakdownAxis = "trigger" | "structure" | "volume" | "htf";
export type PreFilterCriterion =
  | "atr_ratio_min" | "volume_spike_min" | "rsi_extreme_distance";

export interface IndicatorPluginMetadata {
  // ─── Identity & UI ─────────────────────────────────
  readonly id: IndicatorId;
  readonly displayName: string;
  readonly tag: IndicatorTag;
  readonly shortDescription: string;          // 1-line under the checkbox label
  readonly longDescription: string;           // 2-3 sentences, tooltip / popover
  readonly defaultEnabled: false;             // always false (naked default)
}

export interface IndicatorPlugin extends IndicatorPluginMetadata {
  // ─── Compute ───────────────────────────────────────
  computeScalars(candles: Candle[]): Record<string, unknown>;
  computeSeries(candles: Candle[]): IndicatorSeriesContribution;

  // ─── Schema ────────────────────────────────────────
  scalarSchemaFragment(): z.ZodRawShape;

  // ─── Chart rendering ───────────────────────────────
  /** JS source registered in the Playwright page at warmUp.
   *  The script must call window.__registerPlugin(id, handler) where
   *  handler implements: addToChart(chart, paneIndex) → handles;
   *  setData(handles, seriesContribution, candles) → void. */
  readonly chartScript: string;
  readonly chartPane: ChartPaneKind;
  readonly secondaryPaneStretch?: number;     // used if chartPane === "secondary"

  // ─── Prompt fragments ──────────────────────────────
  detectorPromptFragment(scalars: Record<string, unknown>): string | null;
  reviewerPromptFragment?(scalars: Record<string, unknown>): string | null;
  /** Pattern-type hints contributed to the detector's catalog. */
  readonly contributedPatternTypes?: ReadonlyArray<string>;
  /** Optional featured few-shot example (markdown), included when this
   *  plugin is active. */
  featuredFewShotExample?(): string | null;

  // ─── Scoring & pre-filter ──────────────────────────
  readonly breakdownAxes?: ReadonlyArray<BreakdownAxis>;
  readonly preFilterCriterion?: PreFilterCriterion;
}

export type IndicatorSeriesContribution =
  | { kind: "lines"; series: Record<string, (number | null)[]> }
  | { kind: "histogram"; values: (number | { value: number; color: string } | null)[] }
  | { kind: "markers"; markers: Array<{ index: number; position: "above" | "below"; text: string; color: string; shape: "arrowUp" | "arrowDown" | "circle" | "square" }> }
  | { kind: "priceLines"; lines: Array<{ price: number; color: string; style: 0 | 1 | 2; title: string }> }
  | { kind: "compound"; parts: IndicatorSeriesContribution[] };
```

### 4.1 Metadata-only split for frontend bundling

To avoid shipping `chartScript`, prompt-fragment templates, and compute
code into the client bundle, every plugin module exports two entry points:

```
src/adapters/indicators/plugins/<id>/
  metadata.ts            — exports IndicatorPluginMetadata only
  index.ts               — exports the full IndicatorPlugin (server-only)
  chartScript.ts         — exports the inlined JS string
  promptFragments.ts     — fragment builders
```

The frontend imports only `metadata.ts` files (collated via a
`src/shared/indicatorMetadata.ts` aggregator). The backend imports from
`IndicatorRegistry.ts` (full plugins). The TypeScript path/aliases ensure
this split is enforced at compile time.

### 4.2 Registry

```ts
// src/adapters/indicators/IndicatorRegistry.ts (new)
import { emaStackPlugin } from "./plugins/ema_stack";
// … other imports

export const REGISTRY: ReadonlyArray<IndicatorPlugin> = [
  emaStackPlugin, vwapPlugin, bollingerPlugin,
  rsiPlugin, macdPlugin, atrPlugin,
  volumePlugin,
  swingsBosPlugin, recentRangePlugin,
  liquidityPoolsPlugin, fvgPlugin, pocPlugin,
] as const;

export class IndicatorRegistry {
  resolveActive(matrix: WatchConfig["indicators"]): IndicatorPlugin[] {
    return REGISTRY.filter((p) => matrix[p.id]?.enabled === true);
  }
  byId(id: IndicatorId): IndicatorPlugin | undefined {
    return REGISTRY.find((p) => p.id === id);
  }
  allChartScripts(): string {
    return REGISTRY.map((p) => p.chartScript).join("\n");
  }
}
```

The order in `REGISTRY` is the canonical ordering used everywhere
(prompts, charts, UI sections within tags).

---

## 5. Plugin catalog (v1)

For each plugin, the table shows: scalar fields it contributes, what it
puts on the chart, axis contribution, pre-filter contribution.

| id | scalar keys | chart | breakdownAxes | preFilter |
|---|---|---|---|---|
| `ema_stack` | `ema20`, `ema50`, `ema200` | 3 lines on price pane | — | — |
| `vwap` | `vwapSession`, `priceVsVwapPct` | 1 line on price pane | — | — |
| `bollinger` | `bbUpper`, `bbMiddle`, `bbLower`, `bbBandwidthPct`, `bbBandwidthPercentile200` | upper/lower lines on price | — | — |
| `rsi` | `rsi` | secondary pane + 30/70 lines | — | `rsi_extreme_distance` |
| `macd` | `macd`, `macdSignal`, `macdHist` | secondary pane (line+line+hist) | — | — |
| `atr` | `atr`, `atrMa20`, `atrZScore200` | secondary pane (line+line) | — | `atr_ratio_min` |
| `volume` | `volumeMa20`, `lastVolume`, `volumePercentile200` | dedicated pane (histogram + MA20 line) | `volume` | `volume_spike_min` |
| `swings_bos` | `lastSwingHigh`, `lastSwingHighAge`, `lastSwingLow`, `lastSwingLowAge`, `bosState` | swing markers (H/L) on candles | `structure` | — |
| `recent_range` | `recentHigh`, `recentLow` | HH/LL price lines on price pane | `structure` | — |
| `liquidity_pools` | `equalHighsCount`, `equalLowsCount`, `topEqualHighs`, `topEqualLows` | EQH/EQL price lines | `structure` | — |
| `fvg` | (none scalar in v1) | FVG band price lines | `structure` | — |
| `poc` | `pocPrice` | (no chart visual in v1) | `structure` | — |

Notes:
- The `volume` plugin owns the **entire** volume pane. In naked mode,
  there is no volume pane at all. (Decision §2.2 of brainstorm.)
- `fvg` contributes no scalar to the prompt today; that stays. It
  contributes only the chart bands.
- `poc` contributes a scalar but no visual — the price line for POC was
  intentionally omitted in the current implementation; we keep that.

---

## 6. Prompt composition

### 6.1 Detector skeleton (`prompts/detector.md.hbs`, refactor)

```hbs
{{!-- detector_v5 — modular indicators --}}
# Free-form pattern detection on a chart

## Tick context
- Asset / Timeframe : {{asset}} / {{timeframe}}
- Tick at : {{tickAt}}

{{#if activeLessons.length}}
## Active guidelines (learned from previous trades)
{{> active-lessons}}
{{/if}}

{{#if hasIndicators}}
## Indicators (fresh data on {{timeframe}})
{{{indicatorFragments}}}
{{else}}
## Mode
Naked-mode analysis: chart only, no computed indicators. Make use of pure
visual pattern recognition (price action, candle structures, geometric
shapes). The chart attached is your single source of truth. Be creative.
{{/if}}

{{#if htf}}
## Higher timeframe regime
- Daily trend : `{{htf.dailyTrend}}`
{{/if}}

## Alive setups on {{asset}} {{timeframe}}
{{> alive-setups}}

## Chart image
See attached image (Japanese candlestick chart{{#unless hasIndicators}} —
no overlays, candles only{{/unless}}).

## Setup classification (REQUIRED on every new_setup)
{{{classificationBlock}}}

## Few-shot examples
{{{fewShotExamples}}}

{{#if isVolumeActive}}
## Volume rules
{{> volume-matrix}}
{{/if}}

## Fail-closed rules
(unchanged universal block)

## Output format
{{{outputFormatTable}}}
```

### 6.2 PromptBuilder service

```ts
// src/domain/services/PromptBuilder.ts (new)
export class PromptBuilder {
  constructor(
    private registry: IndicatorRegistry,
    private fewShotEngine: FewShotEngine,
  ) {}

  buildDetectorPrompt(args: {
    watch: WatchConfig;
    candles: Candle[];
    scalars: Record<string, unknown>;
    activeLessons: Lesson[];
    aliveSetups: AliveSetup[];
    htf?: HtfSnapshot;
    tickAt: Date;
  }): string {
    const plugins = this.registry.resolveActive(args.watch.indicators);
    const isVolumeActive = plugins.some((p) => p.id === "volume");
    const indicatorFragments = plugins
      .map((p) => p.detectorPromptFragment(args.scalars))
      .filter((s): s is string => s != null)
      .join("\n\n");
    const classificationBlock = this.composeClassificationBlock(plugins, args.watch);
    const fewShotExamples = this.fewShotEngine.compose(plugins);
    const outputFormatTable = this.composeOutputFormatTable(plugins, args.watch);
    return this.template.render({
      ...args,
      hasIndicators: plugins.length > 0,
      isVolumeActive,
      indicatorFragments,
      classificationBlock,
      fewShotExamples,
      outputFormatTable,
    });
  }

  buildReviewerPrompt(args: {
    watch: WatchConfig;
    setup: AliveSetup;
    history: ReviewerHistoryEntry[];
    fresh: { lastClose: number; scalars: Record<string, unknown> };
    activeLessons: Lesson[];
    htf?: HtfSnapshot;
    funding?: FundingSnapshot;
    tickAt: Date;
  }): string { /* same composition pattern as detector */ }
}
```

`composeClassificationBlock` produces the `confidence_breakdown` spec
adapted to the active axes (or the `clarity` 0-100 single-score spec in
naked mode). `composeOutputFormatTable` describes the JSON schema with
the right shape for `confidence_breakdown` / `clarity`.

### 6.3 Few-shot strategy

`src/domain/services/FewShotEngine.ts`:

- 2 generic visual examples (committed in code, not data):
  - "Double bottom by eye" (geometric pattern, no indicator references).
  - "Range chop, ignore_reason" (universal noise example).
- For each active plugin in order, append `featuredFewShotExample()`
  output if non-null. Cap at 3 plugin contributions (5 total
  examples — token budget).
- Naked → only the 2 generic examples.

### 6.4 Plugin fragment format

Single-line bullets in markdown:

```ts
// rsi/promptFragments.ts
export function detectorFragment(scalars) {
  const rsi = scalars.rsi as number;
  return `**RSI (14)**: \`${rsi.toFixed(2)}\` — extreme < 30 / > 70; mid-range neutral.`;
}
export function reviewerFragment(scalars) {
  return `RSI \`${(scalars.rsi as number).toFixed(2)}\``;
}
```

Joined by `PromptBuilder` with `\n\n`. v1 keeps a flat list; future v2
may group by tag.

### 6.5 Reviewer & Finalizer

- Reviewer prompt (`prompts/reviewer.md.hbs`): same skeletonisation as
  detector, condensed reviewer fragments. Plugins with no
  `reviewerPromptFragment` contribute nothing (already common —
  reviewer focuses on deltas).
- Finalizer prompt (`prompts/finalizer.md.hbs`): **untouched in v1**.
  It already cites no scalar indicator values directly — it relies on
  the regime label, HTF block, funding, and the `confidence_breakdown`
  read from the setup history. The breakdown is now adaptive (read from
  the schema), but the prompt's wording about it is left as-is; if it
  drifts, fix in a follow-up.

### 6.6 What disappears from the current detector prompt in naked mode

Tracked here so the implementation plan can verify each item:

- The "Indicators (fresh data)" section (entire block).
- The "Volume — context-dependent" matrix.
- All few-shot example bodies that cite specific scalar values
  (replaced by 2 generic examples).
- The `confidence_breakdown` spec with 4 axes (replaced by `clarity`).
- The pattern-type catalog (`bb_squeeze_break`, `fvg_retest`, `bos_reaction`)
  — these are conditionally listed only when their owning plugin is
  active. In naked, the prompt only lists generic visual pattern names
  (double_top, double_bottom, breakout, gap_fill, range_chop).

What stays in naked: header, active lessons block, alive setups,
classification block (with `clarity` spec), 2 generic few-shot examples,
fail-closed rules, output format table.

---

## 7. Chart composition

### 7.1 Refactored `chart-template.html`

The template becomes a **skeleton**. All chart series creation moves out
to plugin scripts.

```html
<!DOCTYPE html>
<html>
<head>
  <!-- {{LIGHTWEIGHT_CHARTS_INLINE}} -->
  <style>/* unchanged */</style>
</head>
<body>
  <div id="chart"></div>
  <script>
    (() => {
      window.__chartPlugins = {};
      window.__registerPlugin = (id, plugin) => { window.__chartPlugins[id] = plugin; };
    })();
  </script>
  <!-- {{INDICATOR_PLUGIN_SCRIPTS}} - inlined at warmUp by PlaywrightChartRenderer -->
  <script>
    (() => {
      window.__renderCandles = (payload) => {
        const { candles, indicators, enabledIndicatorIds } = payload;
        const LC = LightweightCharts;
        const chart = LC.createChart(document.getElementById("chart"), {
          layout: { background: { color: "#131722" }, textColor: "#d1d4dc",
                    panes: { separatorColor: "#2a2e39" } },
          grid: { vertLines: { color: "#2a2e39" }, horzLines: { color: "#2a2e39" } },
          timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#485158" },
          rightPriceScale: { borderColor: "#485158" },
          crosshair: { mode: 0 },
        });
        const candleSeries = chart.addSeries(LC.CandlestickSeries, {
          upColor: "#26a69a", downColor: "#ef5350",
          borderVisible: enabledIndicatorIds.length === 0, // crisper in naked
          wickUpColor: "#26a69a", wickDownColor: "#ef5350",
          lastValueVisible: enabledIndicatorIds.length === 0, // useful anchor in naked
        }, 0);
        candleSeries.setData(candles);

        let nextPane = 1;
        const stretchByPaneIndex = new Map();
        for (const id of enabledIndicatorIds) {
          const plugin = window.__chartPlugins[id];
          if (!plugin) continue;
          const paneIndex = plugin.chartPane === "price_overlay" ? 0 : nextPane++;
          const handles = plugin.addToChart(chart, paneIndex, { candleSeries });
          plugin.setData(handles, indicators[id], candles);
          if (paneIndex > 0) {
            stretchByPaneIndex.set(paneIndex, plugin.secondaryPaneStretch ?? 13);
          }
        }

        const panes = chart.panes();
        if (panes[0]) panes[0].setStretchFactor(50);
        for (const [idx, stretch] of stretchByPaneIndex) {
          if (panes[idx]) panes[idx].setStretchFactor(stretch);
        }

        chart.timeScale().fitContent();
        requestAnimationFrame(() => requestAnimationFrame(() => { window.__chartReady = true; }));
      };
    })();
  </script>
</body>
</html>
```

### 7.2 Plugin chartScript shape

Example (`rsi/chartScript.ts`):

```ts
export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("rsi", {
    chartPane: "secondary",          // matches IndicatorPlugin.chartPane
    secondaryPaneStretch: 13,        // matches IndicatorPlugin.secondaryPaneStretch
    addToChart(chart, paneIndex) {
      const rsi = chart.addSeries(LC.LineSeries, {
        color: "#ce93d8", lineWidth: 1, lastValueVisible: true,
        title: "RSI(14)",
      }, paneIndex);
      rsi.createPriceLine({ price: 70, color: "#666", lineWidth: 1, lineStyle: 2 });
      rsi.createPriceLine({ price: 30, color: "#666", lineWidth: 1, lineStyle: 2 });
      return { rsi };
    },
    setData(handles, contribution, candles) {
      const data = contribution.series.rsi
        .map((v, i) => v == null ? null : { time: candles[i].time, value: v })
        .filter(Boolean);
      handles.rsi.setData(data);
    },
  });
})();
`;
```

The `PlaywrightChartRenderer.warmUp()` reads `registry.allChartScripts()`
once and inlines all of them between the registry helper script and
`__renderCandles`. Page pool is preserved between watches (template is
fixed; the activation is data-driven via `enabledIndicatorIds`).

### 7.3 Dynamic pane layout

- Price pane: stretch factor `50` always.
- Each secondary pane gets the plugin's `stretch` (default `13`).
- ATR-like minor panes can declare `stretch: 11`.
- In naked mode, no secondary panes → price gets the full canvas.

### 7.4 Naked-mode visual quality

Per the goal of optimising the screenshot in naked:

- Viewport bumped to **1280×900** in naked (default 1280×720) — taller
  candles, easier visual reading. Caps at 1568px via Sharp anyway. The
  caller (analysis-worker / scheduler) computes the dimensions from the
  active matrix and passes them to `PlaywrightChartRenderer.render`,
  which already accepts `width` / `height`.
- `borderVisible: true` on candles (richer body shape).
- `lastValueVisible: true` on the candle series (right-edge price tag).
- Grid vertical lines very subtle (`#1f2330` instead of `#2a2e39`).
- No markers, no price lines, no overlays.

These knobs live in the `__renderCandles` skeleton, branching on
`enabledIndicatorIds.length === 0`.

### 7.5 File layout

```
src/adapters/indicators/
  IndicatorRegistry.ts
  plugins/
    base/
      paneHelpers.ts          (lineFromSeries util shared across plugins)
    ema_stack/
      index.ts
      metadata.ts
      chartScript.ts
      promptFragments.ts
      compute.ts
    vwap/...
    bollinger/...
    …
  PureJsIndicatorCalculator.ts  (refactored: delegates to plugins)
```

`PureJsIndicatorCalculator` keeps its public ports (`compute` /
`computeSeries`) but delegates to `registry.resolveActive(...)`. The math
helpers (`emaSeriesAligned`, `bollingerSeriesAligned`, etc.) move into
the relevant plugin's `compute.ts` or into a shared `base/math.ts`.

---

## 8. Frontend wizard step

### 8.1 Wizard ordering

Insertion at position 2 (between "Asset" and "Schedule"):

```
1. Asset
2. Indicateurs              ← NEW
3. Schedule
4. Lifecycle
5. Analyzers
6. Notifs & budget
7. Avancé
```

In edit mode (`edit-tabs.tsx`), the same tab order applies.

Step definition in `src/client/components/watch-form/index.tsx`:

```ts
{
  id: "indicators",
  title: "Indicateurs",
  description: "Choisis quels indicateurs techniques le bot utilise pour analyser cette watch. Aucun indicateur = analyse purement visuelle (mode naked).",
  fields: ["indicators"],
  render: () => <SectionIndicators />,
}
```

### 8.2 Section layout

Vertical stack:

```
┌─ INFORMATIVE CARD (collapsible) ──────────────────────┐
│ • Mode naked vs équipé : ce qui change                │
│ • Concept du confidence_breakdown adaptatif           │
│ • Trade-off tokens / coût (chaque plugin = +tokens)   │
└───────────────────────────────────────────────────────┘
┌─ PRESETS ─────────────────────────────────────────────┐
│ [ Naked ] [ Recommended ] [ Tout cocher ]             │
│                              [ Tout décocher ]        │
└───────────────────────────────────────────────────────┘
┌─ INDICATORS BY TAG (collapsible per tag) ─────────────┐
│  TREND                                                │
│  ☐ EMA stack (20/50/200)  [ⓘ]                         │
│     Repère de tendance multi-horizon…                 │
│  ☐ VWAP                   [ⓘ]                         │
│  …                                                    │
│  VOLATILITY                                           │
│  …                                                    │
└───────────────────────────────────────────────────────┘
```

### 8.3 Component split

```
src/client/components/watch-form/
  section-indicators.tsx              (new)
    ├── IndicatorsInfoCard
    ├── IndicatorsPresets
    └── IndicatorsByTag
src/client/lib/indicatorsPresets.ts   (new)
  export const PRESETS = {
    naked: [],
    recommended: ["ema_stack", "rsi", "volume", "swings_bos"],
    all: KNOWN_INDICATOR_IDS,
  };
src/shared/indicatorMetadata.ts       (new)
  // re-export of metadata-only entries from each plugin
```

### 8.4 RHF integration

Each checkbox is bound to `indicators.${id}.enabled` via `useFormContext`.
When a preset button is clicked, it calls `form.setValue("indicators", buildMatrix(preset))`.
A computed selector reads the active set and passes it to the
informative card's "X indicateurs actifs / tokens estimés" panel.

### 8.5 Indicator descriptions (excerpt)

| id | shortDescription | longDescription |
|---|---|---|
| `ema_stack` | "Tendance multi-horizon" | "EMAs 20/50/200 alignées = régime de tendance clair. Inversion de l'empilement = changement de régime." |
| `rsi` | "Momentum / surachat-survente" | "Oscillateur 0-100. Extrêmes < 30 / > 70 signalent surextension. Divergences entre prix et RSI = retournement potentiel." |
| `volume` | "Pane volume + MA20 + percentile" | "Histogramme du volume coloré par direction de bougie. La MA20 et le percentile vs 200 bougies permettent de juger si le volume est anormal pour cet asset." |
| `bollinger` | "Volatilité & squeeze" | "Bandes ±2σ. Compression (squeeze) = vol comprimée → expansion à venir. Bandwidth-percentile vs 200 bougies = squeeze calibré per-asset." |
| `swings_bos` | "Structure swings + Break-of-Structure" | "Swings hauts/bas (fractale 3 bougies) + état du dernier BOS (haussier / baissier / range). Base de l'analyse de structure." |
| `liquidity_pools` | "Liquidité (EQH / EQL)" | "Clusters d'égalités de pivots — pools de liquidité où les ordres stop sont concentrés. Cibles de sweep / rejets potentiels." |
| `fvg` | "Fair Value Gaps" | "Imbalances 3-bougies non comblées — niveaux où le prix peut revenir tester la zone manquée." |
| `poc` | "Point of Control (volume profile)" | "Niveau de prix avec le plus de volume traité sur la fenêtre récente. Aimant / ancre de mean-reversion." |
| `recent_range` | "High/Low récents (50p)" | "Plus haut et plus bas des 50 dernières bougies — bornes structurelles immédiates." |
| `vwap` | "VWAP session" | "Volume-weighted average price ancré au début de la session UTC. Repère institutionnel." |
| `macd` | "Convergence/divergence des EMAs" | "MACD (12,26,9). Croisement de l'histogramme de signe = pivot momentum." |
| `atr` | "Volatility absolue" | "Average True Range (14) + MA20. ATR-Z200 = compression vs régime normal. Sert à dimensionner les stops." |

### 8.6 Pre-filter UX hint

In step "Avancé" (existing `section-advanced.tsx`), the fields
`atr_ratio_min` / `volume_spike_min` / `rsi_extreme_distance` get an
inline hint computed from the form's current `indicators` state:

```tsx
{!isAtrActive && (
  <p className="text-xs text-muted-foreground">
    Désactivé automatiquement (indicateur ATR non sélectionné)
  </p>
)}
```

The pre-filter "enabled" toggle remains user-controlled; only the
*criteria* degrade.

---

## 9. Pre-filter graceful degradation (β)

`src/workflows/scheduler/preFilter.ts` is updated:

```ts
export function shouldKeep(
  snapshot: TickSnapshot,
  watch: WatchConfig,
  registry: IndicatorRegistry,
): boolean {
  if (!watch.pre_filter.enabled || watch.pre_filter.mode === "off") return true;
  const active = registry.resolveActive(watch.indicators);
  const activeCriteria = new Set(
    active.map((p) => p.preFilterCriterion).filter((c): c is PreFilterCriterion => !!c),
  );

  let kept = 0, evaluated = 0;
  if (activeCriteria.has("atr_ratio_min")) {
    evaluated++;
    if (snapshot.atrRatio >= watch.pre_filter.thresholds.atr_ratio_min) kept++;
  }
  if (activeCriteria.has("volume_spike_min")) {
    evaluated++;
    if (snapshot.volumeRatio >= watch.pre_filter.thresholds.volume_spike_min) kept++;
  }
  if (activeCriteria.has("rsi_extreme_distance")) {
    evaluated++;
    if (snapshot.rsiExtremeDistance >= watch.pre_filter.thresholds.rsi_extreme_distance) kept++;
  }

  if (evaluated === 0) return true; // all criteria disabled → pre-filter inactive
  return watch.pre_filter.mode === "lenient" ? kept >= 1 : kept === evaluated;
}
```

Note: `TickSnapshot` already carries `atrRatio`, `volumeRatio`, and
`rsi`. If `rsi` is off, the snapshot may not have it computed — the
function must read from the snapshot's actual scalar set; missing scalar
means the criterion can't be evaluated → counted as not active. The
`TickSnapshot` capture path also branches on the active matrix to
avoid computing values that aren't going to be used.

---

## 10. Migration: nuke

- **No migration code is written.** The schema change to `WatchSchema`
  adds `indicators` with default `{}`.
- A one-shot `scripts/nuke-trading-flow.ts` executes at deploy time:

```ts
// Deletes all rows from:
//   watches, setups, setup_outputs, tick_snapshots,
//   lessons, lesson_proposals, llm_calls, post_mortem_artifacts
// Confirms via interactive prompt.
```

- The user re-creates watches via the new wizard. Lessons accumulate
  fresh from the next setups.
- DB schema (Drizzle): if `WatchConfig` is stored as a typed row, a
  migration adds `indicators jsonb NOT NULL DEFAULT '{}'`. The
  implementation plan investigates the current shape and drafts the
  migration accordingly.

---

## 11. Testing strategy

### 11.1 Unit (per plugin)

`test/adapters/indicators/plugins/<id>/`:
- `compute.test.ts` — fixture candles → expected scalars and series
  (boundary cases: insufficient warm-up, all-zero volume, etc.).
- `promptFragments.test.ts` — snapshot of detector / reviewer fragment
  output for representative scalar inputs; null-safe behaviour.
- `metadata.test.ts` — schema fragment validates known good data,
  rejects bad data.

### 11.2 Integration

`test/adapters/indicators/IndicatorRegistry.test.ts`:
- `resolveActive(matrix)` ordering is stable.
- `buildIndicatorsSchema(plugins)` accepts/rejects expected shapes.
- `buildConfidenceBreakdownSchema` returns `{clarity}` in naked,
  `{trigger, structure, volume, htf}` superset depending on plugins.

### 11.3 Prompt composition

`test/domain/services/PromptBuilder.test.ts`:
- 3 fixture combinations: naked / recommended / full.
- Snapshot the composed detector + reviewer prompt strings.
- Assert presence/absence of marker sections (`Indicators` block,
  `Volume rules` block, `clarity` vs `confidence_breakdown` etc.).
- Assert few-shot examples count and content.

### 11.4 Chart rendering regression

Extend `test/adapters/chart/PlaywrightChartRenderer.regression`:
- Add scenarios for naked, recommended, full.
- Assert `enabledIndicatorIds` is honoured (count of panes, presence of
  EMA / RSI / etc.).
- Snapshot images via sha256 (deterministic) or pixelmatch tolerance.

### 11.5 Pre-filter

`test/workflows/scheduler/preFilter.test.ts`:
- All 3 criteria active → strict / lenient behaviour.
- `atr` off + `rsi` off + `volume` on → only `volume_spike_min`
  evaluated.
- All 3 off → `evaluated === 0` → returns `true`.

### 11.6 End-to-end front

Out of scope v1. Manual validation of the wizard step (presets,
descriptions, RHF binding, save → reload).

---

## 12. Phasing

**v1 (this spec)**:
- `IndicatorPlugin` contract and registry.
- 12 plugins migrated from current code, preserving today's behaviour
  when "all enabled".
- `WatchSchema.indicators` field + dynamic `IndicatorsSchema` +
  adaptive `ConfidenceBreakdownSchema`.
- Detector + Reviewer prompts re-skeletonised; finalizer untouched.
- `PlaywrightChartRenderer` re-skeletonised with plugin scripts.
- Wizard step `Indicateurs` with informative card, presets,
  per-tag sections, descriptions, tooltips.
- `preFilter.ts` graceful β degradation with UX hint.
- All tests above.
- `scripts/nuke-trading-flow.ts` deployed once.

**v2 (next iteration)**:
- Plugin params: each plugin exposes `paramsSchema`. UI renders a
  collapsible panel under each checked indicator. `inputHash` recompute
  includes params. Migration: existing v1 watches default to current
  parameter values; users can edit thereafter.

**v3 (future)**:
- User-authored / marketplace plugins.

---

## 13. Open points / risks

1. **Persistence of `WatchConfig`** — TBD whether the watches table
   stores it column-typed or as JSON. The implementation plan must
   inspect `src/adapters/persistence/schema.ts` and draft the Drizzle
   migration if needed.
2. **Backward-compat of finalizer prompt** — the finalizer reads
   `confidence_breakdown` text; the new shape (clarity vs adaptive
   axes) must be reflected in the prompt's wording or it will continue
   to reference 4 fixed axes. Audit during implementation.
3. **TickSnapshot capture path** — must branch on the active matrix
   to avoid computing scalars that won't be used (token + CPU budget).
4. **Few-shot token budget** — 2 generic + ≤3 plugin = up to 5
   examples. With 12 plugins, the user's "full TA" preset may pick 3
   featured ones non-deterministically (registry order-dependent).
   Acceptable in v1; revisit if it biases scoring.
5. **Reviewer's `request_additional` HTF chart** — when active, the
   2nd image should also be rendered with the same `enabledIndicatorIds`
   matrix? Or is the daily chart always full TA for context? Assume
   "same matrix" in v1 for consistency; flag if different.
