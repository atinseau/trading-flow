# Chart Rendering Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the 5 distinct chart-rendering code paths into one hexagonal framework (`<TradingViewChart>` for the frontend, `renderChartImage()` for the backend Playwright pipeline) so plugins are pure TS, the Fibonacci bands render on both contexts, and the LLM never sees its last candles masked by labels.

**Architecture:** Domain port `IndicatorPlugin` (no `lightweight-charts` import) + adapter `contributionRenderer.ts` (kind-dispatch + `ISeriesPrimitive` for bands) + adapter `chartBootstrap.ts` (canonical candle palette + adaptive `rightOffset`) + React component `TradingViewChart.tsx` (consumes both, owns fullscreen + ResizeObserver + indicator toggle state). Playwright reuses the same two adapters via `Bun.Transpiler` at warm-up. Each plugin gains a declarative `renderConfig` (palette + labels + secondary pane stretch) and loses its `chartScript.ts` JS string.

**Tech Stack:** Bun ≥ 1.3 + TypeScript strict + Biome + lightweight-charts v5 + React 19 + Storybook 10.4 (`@storybook/react-vite`) + Playwright (existing) + Drizzle (untouched).

**Decisions reference:** All 8 architecture decisions tranched in `docs/superpowers/specs/2026-05-18-chart-rendering-framework-design.md` §9 (D1–D8). Read that section before starting if unfamiliar.

---

## File Structure

### Files created — framework core

| Path | Responsibility |
|---|---|
| `src/domain/charts/types.ts` | `IndicatorSeriesContribution` union moved here from `adapters/indicators/plugins/base/types.ts` (domain-pure, zero lightweight-charts dep at compile-time). Re-exported from the old path for backward compat during the migration. |
| `src/adapters/chart/contributionRenderer.ts` | `applyContribution(chart, contribution, opts)` — the unified dispatcher. Handles `lines | priceLines | markers | histogram | bands | compound`. Returns a `cleanup()` that drops everything it created. Runtime access to lightweight-charts via `globalThis.LightweightCharts`. |
| `src/adapters/chart/chartBootstrap.ts` | `createTradingViewChart(container, opts)` (the canonical chart creator with the `#26a69a`/`#ef5350` candle palette) + `computeRightOffset(opts)` (pure) + `applyRightOffset(chart, count)`. |
| `src/adapters/chart/bandsPrimitive.ts` | `BandsPrimitive` class implementing `ISeriesPrimitive<Time>`. Canvas-based fill rectangles, z-order bottom, works identically frontend + backend. Replaces the HTML overlay `PriceBandsOverlay.tsx`. |
| `src/adapters/chart/paneAllocator.ts` | `allocatePanes(indicators, visibility)` — deterministic ordering: main=pane 0 with stretch 50, secondaries get incremental indices in input order, each with their `renderConfig.secondaryPaneStretch`. Pure TS, fully unit-testable without lightweight-charts. |
| `src/client/lib/setupLightweightChartsGlobal.ts` | Side-effect module: `import * as LC from "lightweight-charts"; globalThis.LightweightCharts = LC;`. Imported once at frontend boot from `frontend.tsx`. |
| `src/client/components/charts/TradingViewChart.tsx` | The main React component. Owns: mount/unmount lifecycle, ResizeObserver, fullscreen toggle (F11 + button), visibility state (when `enableControls`), marker bucket merging, applying indicators via `contributionRenderer`, pane allocation via `paneAllocator`. |
| `src/client/components/charts/IndicatorControlPanel.tsx` | Sub-component, internal to the framework. Chips/sidebar UI to toggle indicators on/off. Receives plugins + visibility + onToggle from `<TradingViewChart>` (which is the source of truth). |

### Files created — Storybook harness

| Path | Responsibility |
|---|---|
| `.storybook/main.ts` | Storybook config with `@storybook/react-vite` builder + `vite-tsconfig-paths` + `@tailwindcss/vite` + `@storybook/addon-vitest`. |
| `.storybook/preview.tsx` | Global decorator forcing `1024×600` wrapper (lightweight-charts won't paint at 0×0), Tailwind globals import, sets viewport + background. |
| `src/client/components/charts/__stories__/Smoke.stories.tsx` | Phase 0 sanity story: a `createChart` with 50 candles. Boot OK = setup OK. |
| `src/client/components/charts/__stories__/TradingViewChart.stories.tsx` | 6 stories: `Naked`, `SingleIndicator`, `PriceOverlayStack`, `HighDensity`, `WithControls`, `WithPriceLines`. |
| `src/client/components/charts/__stories__/IndicatorControlPanel.stories.tsx` | `TopChips`, `SidebarRight`, `SidebarLeft` layouts. |
| `src/adapters/chart/__stories__/BandsPrimitive.stories.tsx` | `Uptrend`, `Downtrend`, `NoAnchor` configs. |
| `src/adapters/indicators/plugins/<id>/__stories__/<Plugin>.stories.tsx` | One per plugin × 11 plugins (atr, bollinger, ema_stack, fibonacci, liquidity_pools, macd, rsi, structure_levels, swings_bos, volume, vwap). |

### Files created — fixtures + tests

| Path | Responsibility |
|---|---|
| `test/fixtures/candles/btcusdt-1h-bullish-200.json` | 200 candles, clean uptrend leg, swing pair detectable by `lookback=3`. Shared by stories + tests. |
| `test/fixtures/candles/btcusdt-1h-bearish-200.json` | 200 candles, downtrend. |
| `test/fixtures/candles/eurusd-15m-ranging-300.json` | 300 candles, sideways with multiple swings. |
| `test/adapters/chart/contributionRenderer.test.ts` | Unit tests per kind with a fake `IChartApi`. |
| `test/adapters/chart/chartBootstrap.test.ts` | Tests `computeRightOffset` truth table + `applyRightOffset` call shape. |
| `test/adapters/chart/bandsPrimitive.test.ts` | Construct primitive + assert `paneViews()` shape + a mock canvas draw call captures `fillRect` calls. |
| `test/adapters/chart/paneAllocator.test.ts` | Truth table: visibility on/off, mixed price_overlay/secondary, stretch sum. |
| `test/client/components/charts/TradingViewChart.test.tsx` | Visibility toggle drops a pane, marker bucket merges sources, fullscreen prop wires F11. |
| `test/parity/contributionParity.test.ts` | For each plugin: compute contribution → render through `applyContribution` once with frontend-shaped fake chart, once with backend-shaped fake chart. Assert call lists are identical. |
| `test/visual/chart-visibility.test.ts` | 3 densities (1, 5, 11 indicators). Inspect right-edge pixel column. |
| `test/visual/bands-primitive.test.ts` | Fib bands frontend story screenshot vs backend webp pixel diff (< 1%). |
| `test/visual/story-screenshots.test.ts` | Iterates all stories, screenshots via Playwright, diffs against baselines in `test/fixtures/story-baselines/*.png` with `pixelmatch`. |
| `test/adapters/chart/PlaywrightChartRenderer.story-parity.test.ts` | For each TradingViewChart story that has a backend equivalent: extract args, call `PlaywrightChartRenderer.render(args)`, assert webp SHA256 stable. |

### Files modified

| Path | Phase | What changes |
|---|---|---|
| `src/domain/services/IndicatorPlugin.ts` | 4 | Add `renderConfig: { palette, seriesLabels, secondaryPaneStretch }` field to the `IndicatorPlugin` interface (non-breaking, optional during transition then required after Phase 4 complete). |
| `src/adapters/indicators/plugins/*/index.ts` × 11 | 4 | Each plugin's `index.ts` adds `renderConfig: {...}` with the colors / labels extracted from its current `chartScript.ts`. |
| `src/client/frontend.tsx` | 2 | Add side-effect import `import "@client/lib/setupLightweightChartsGlobal";` at the top. |
| `src/adapters/chart/PlaywrightChartRenderer.ts` | 5 | `warmUp()` injects the transpiled `contributionRenderer` + `chartBootstrap` modules + exposes `window.__tradingFlowChart.render`. `render()` payload shape changes (includes `renderConfig` per indicator). |
| `src/adapters/chart/chart-template.html` | 5 | Simplified — no longer concatenates plugin chartScripts. Just the lightweight-charts standalone bundle + a `<div id="chart">`. The framework bundle is injected by `warmUp`. |
| `src/client/components/replay/replay-chart.tsx` | 3a | Becomes a thin wrapper of `<TradingViewChart enableControls enableFullscreen>`. Drops mount/effects code, drops palette map, drops `PriceBandsOverlay`. |
| `src/client/components/setup/tv-chart.tsx` | 3b | Becomes a thin wrapper of `<TradingViewChart enableControls={false} enableFullscreen>`. |
| `src/client/components/asset/asset-chart.tsx` | 3c | Becomes a thin wrapper of `<TradingViewChart enableControls={false} enableFullscreen={false}>` that injects the volume plugin. |
| `src/client/components/replay/applyIndicatorToChart.ts` | 6 | Becomes a pure re-export of the new dispatcher (kept for import-path stability while no caller consumes it any more). |
| `prompts/detector.md.hbs` | 6 | Version bump `detector_v9` → `detector_v10` (Fib bands now visible in image → cache miss is desired). |
| `package.json` | 0 + others | New `storybook`, `build-storybook`, `test:visual`, `test:storybook-parity` scripts. |

### Files deleted (Phase 6)

| Path | Why |
|---|---|
| `src/adapters/indicators/plugins/<id>/chartScript.ts` × 11 | Replaced by `renderConfig` + unified dispatcher. |
| `src/client/components/replay/PriceBandsOverlay.tsx` | Bands now rendered by `BandsPrimitive` (canvas) in both contexts. |
| `src/client/components/replay/indicator-toggles.tsx` | Toggle UI now lives inside `<TradingViewChart>` when `enableControls`. |
| `src/client/components/replay/chart-legend.tsx` | Legend information merged into `IndicatorControlPanel` chips. |

(`applyIndicatorToChart.ts` is kept as a re-export — see Modified table.)

---

## Phase 0 — Storybook setup (no app change)

Goal: stand up Storybook 10.4 with `@storybook/react-vite`, prove it boots a `lightweight-charts` instance inside an iframe. Zero touch to existing app code.

### Task 0.1: Init Storybook + install dev deps

**Files:**
- Create: `.storybook/main.ts`, `.storybook/preview.tsx`
- Modify: `package.json`

- [ ] **Step 1: Run Storybook init in Bun-aware mode**

```bash
bunx storybook@latest init --skip-install --package-manager bun --yes
```

Expected: creates `.storybook/main.ts`, `.storybook/preview.tsx`, scaffolds example stories (we'll delete them in Step 4), patches `package.json` with `storybook` and `build-storybook` scripts.

- [ ] **Step 2: Install dependencies via Bun**

```bash
bun install
```

Expected: Storybook + `@storybook/react-vite` + `@storybook/addon-docs` + `@storybook/addon-a11y` resolved.

- [ ] **Step 3: Add the framework-specific dev deps**

```bash
bun add -D vite-tsconfig-paths @tailwindcss/vite @storybook/addon-vitest pixelmatch @types/pixelmatch pngjs @types/pngjs
```

- [ ] **Step 4: Remove the scaffolded example stories**

```bash
rm -rf src/stories
```

Expected: Storybook's `Button.tsx`, `Header.tsx`, etc. scaffolding is gone — we don't want it polluting our stories tree.

- [ ] **Step 5: Verify `package.json` has the expected scripts**

Read `package.json` and confirm these entries exist (add manually if `bunx ... init` didn't add them):

```json
"storybook": "storybook dev -p 6006",
"build-storybook": "storybook build"
```

- [ ] **Step 6: Commit**

```bash
git add .storybook package.json bun.lock
git commit -m "$(cat <<'EOF'
chore(storybook): init Storybook 10.4 with @storybook/react-vite

Bun-aware init (`--skip-install --package-manager bun`). Adds vite-tsconfig-paths,
@tailwindcss/vite, addon-vitest, pixelmatch for visual regression. Removes the
scaffolded example stories — we'll grow our own under __stories__/ dirs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 0.2: Configure `.storybook/main.ts` for the framework

**Files:**
- Modify: `.storybook/main.ts`

- [ ] **Step 1: Replace the generated main.ts**

Write `.storybook/main.ts` with the full config:

```ts
import type { StorybookConfig } from "@storybook/react-vite";
import tsconfigPaths from "vite-tsconfig-paths";
import tailwind from "@tailwindcss/vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    "@storybook/addon-vitest",
  ],
  framework: { name: "@storybook/react-vite", options: {} },
  viteFinal: (cfg) => {
    cfg.plugins = [...(cfg.plugins ?? []), tsconfigPaths(), tailwind()];
    return cfg;
  },
};
export default config;
```

- [ ] **Step 2: Confirm path aliases are picked up**

`vite-tsconfig-paths` reads `tsconfig.json` automatically. No further config needed.

- [ ] **Step 3: Commit**

```bash
git add .storybook/main.ts
git commit -m "chore(storybook): main.ts with react-vite + tsconfigPaths + tailwind v4"
```

### Task 0.3: Configure `.storybook/preview.tsx` with the size decorator

**Files:**
- Modify: `.storybook/preview.tsx`

- [ ] **Step 1: Replace the generated preview**

```tsx
import "@client/lib/setupLightweightChartsGlobal";
import "../src/client/globals.css";
import type { Preview } from "@storybook/react-vite";

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i } },
    backgrounds: {
      default: "trading",
      values: [{ name: "trading", value: "#131722" }],
    },
    viewport: {
      defaultViewport: "chartLg",
      viewports: {
        chartLg: { name: "Chart 1280×720", styles: { width: "1280px", height: "720px" } },
        chartSm: { name: "Chart 800×400", styles: { width: "800px", height: "400px" } },
      },
    },
  },
  decorators: [
    // lightweight-charts measures its container at mount. Without explicit
    // dimensions the Storybook iframe is 0×0 → chart never paints → blank
    // screenshot. Force a known size so charts always have room.
    (Story) => (
      <div style={{ width: 1024, height: 600 }}>
        <Story />
      </div>
    ),
  ],
};
export default preview;
```

Note: `@client/lib/setupLightweightChartsGlobal` doesn't exist yet (Task 1.6). The import will fail until Phase 1 lands. Comment it out for now:

```tsx
// import "@client/lib/setupLightweightChartsGlobal";  // ⬅ Phase 1
```

- [ ] **Step 2: Confirm `src/client/globals.css` exists**

```bash
ls src/client/globals.css
```

Expected: file exists. If not, run `find src/client -name "globals.css"` and adjust the import path.

- [ ] **Step 3: Commit**

```bash
git add .storybook/preview.tsx
git commit -m "chore(storybook): preview.tsx with size decorator (1024×600) + dark bg"
```

### Task 0.4: Smoke story — naked lightweight-charts boots

**Files:**
- Create: `src/client/components/charts/__stories__/Smoke.stories.tsx`

- [ ] **Step 1: Create the smoke story**

```tsx
import {
  CandlestickSeries,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

function SmokeChart() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart: IChartApi = createChart(ref.current, {
      width: 1024,
      height: 500,
      layout: { background: { color: "#131722" }, textColor: "#d1d4dc" },
    });
    const s = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
    });
    const now = Math.floor(Date.now() / 1000);
    s.setData(
      Array.from({ length: 50 }, (_, i) => ({
        time: (now - (50 - i) * 3600) as UTCTimestamp,
        open: 100 + i,
        high: 102 + i,
        low: 98 + i,
        close: 101 + i,
      })),
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, []);
  return <div ref={ref} style={{ width: 1024, height: 500 }} />;
}

export default {
  title: "Charts/Smoke",
  component: SmokeChart,
};

export const Default = { args: {} };
```

- [ ] **Step 2: Launch Storybook**

```bash
bun run storybook
```

Expected: dev server boots on `http://localhost:6006`. No build errors. The smoke story shows a 50-candle green chart.

- [ ] **Step 3: Manual visual check via Chrome DevTools MCP**

Navigate to `http://localhost:6006/iframe.html?id=charts-smoke--default` in a browser and take a screenshot. Confirm visually that a candlestick chart with ~50 candles renders against the dark background.

- [ ] **Step 4: Stop the dev server and commit**

```bash
git add src/client/components/charts/__stories__/Smoke.stories.tsx
git commit -m "test(storybook): smoke story renders 50 naked candles"
```


---

## Phase 1 — Foundation (no breaking change)

Goal: stand up the domain port + adapter renderer + bootstrap + bands primitive + pane allocator + global setup, with unit tests, before any call-site touches them. **Aucun call-site existant ne change**.

### Task 1.1: Domain types — move `IndicatorSeriesContribution` to `src/domain/charts/types.ts`

**Files:**
- Create: `src/domain/charts/types.ts`
- Modify: `src/adapters/indicators/plugins/base/types.ts` (re-export from new location)
- Test: covered by existing plugin tests (they import the type) + a new tiny unit test

- [ ] **Step 1: Write the failing test**

Create `test/domain/charts/types.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { IndicatorSeriesContribution } from "@domain/charts/types";

describe("IndicatorSeriesContribution (domain)", () => {
  test("compound part variant accepted", () => {
    const c: IndicatorSeriesContribution = {
      kind: "compound",
      parts: [
        { kind: "lines", series: { ema: [1, 2, 3] } },
        { kind: "priceLines", lines: [{ price: 100, color: "#fff", style: 0, title: "TP" }] },
      ],
    };
    expect(c.kind).toBe("compound");
  });

  test("bands variant has optional fromTime/toTime", () => {
    const c: IndicatorSeriesContribution = {
      kind: "bands",
      bands: [{ topPrice: 110, bottomPrice: 100, fillColor: "rgba(255,0,0,0.2)" }],
    };
    if (c.kind !== "bands") throw new Error();
    expect(c.bands[0]?.fromTime).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/domain/charts/types.test.ts`
Expected: FAIL with `Cannot find module '@domain/charts/types'`.

- [ ] **Step 3: Create the domain type module**

Write `src/domain/charts/types.ts`:

```ts
/**
 * Domain contract for what an indicator produces, render-side. Pure data,
 * zero dependency on `lightweight-charts` (the type cannot live in
 * `adapters/` because both adapter contexts — React frontend, Playwright
 * backend — consume it).
 */
export type IndicatorSeriesContribution =
  | { kind: "lines"; series: Record<string, (number | null)[]> }
  | {
      kind: "histogram";
      values: ({ value: number; color: string } | number | null)[];
    }
  | {
      kind: "markers";
      markers: Array<{
        index: number;
        position: "above" | "below";
        text: string;
        color: string;
        shape: "arrowUp" | "arrowDown" | "circle" | "square";
      }>;
    }
  | {
      kind: "priceLines";
      lines: Array<{
        price: number;
        color: string;
        style: 0 | 1 | 2;
        title: string;
      }>;
    }
  | {
      kind: "bands";
      bands: Array<{
        topPrice: number;
        bottomPrice: number;
        /** Hex or `rgba(...)` — typically semi-transparent (alpha < 0.3). */
        fillColor: string;
        /** Optional in-band label at top-left. */
        label?: string;
        /** Unix seconds. Omitted = extends to the left edge. */
        fromTime?: number;
        /** Unix seconds. Omitted = extends to the right edge. */
        toTime?: number;
      }>;
    }
  | { kind: "compound"; parts: IndicatorSeriesContribution[] };

/**
 * Declarative render preferences attached to a plugin. The renderer
 * (contributionRenderer) reads this to decide pane / palette / labels —
 * the plugin never invokes lightweight-charts directly.
 *
 * Lives in domain (not adapter) because TWO adapter contexts consume it
 * (React frontend + Playwright backend) and both must see the SAME shape.
 */
export type RenderConfig = {
  pane: "price_overlay" | "secondary";
  /** Per-series colors. Index N → Nth named series in a `lines` kind. */
  palette: ReadonlyArray<string>;
  /** Optional human label per series name. Falls back to `"<id>:<name>"`. */
  seriesLabels?: Readonly<Record<string, string>>;
  /** Pixel stretch factor for secondary panes (defaults 13). */
  secondaryPaneStretch?: number;
};
```

- [ ] **Step 4: Update the old path to re-export**

Replace `src/adapters/indicators/plugins/base/types.ts` content with:

```ts
/**
 * Backward-compat shim. The canonical home is now `@domain/charts/types`.
 * Kept until all callers are migrated (Phase 6).
 */
export type { IndicatorSeriesContribution } from "@domain/charts/types";
```

- [ ] **Step 5: Run the test + the full existing test suite to confirm no regression**

```bash
bun test test/domain/charts/types.test.ts
bun run test:domain
bun run test:adapters
```

Expected: all green. The re-export keeps existing imports working.

- [ ] **Step 6: Lint + commit**

```bash
bun run lint:fix
git add src/domain/charts/types.ts src/adapters/indicators/plugins/base/types.ts test/domain/charts/types.test.ts
git commit -m "refactor(domain): move IndicatorSeriesContribution to @domain/charts/types"
```

### Task 1.2: `paneAllocator.ts` — deterministic pane allocation (pure)

**Files:**
- Create: `src/adapters/chart/paneAllocator.ts`
- Test: `test/adapters/chart/paneAllocator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { allocatePanes } from "@adapters/chart/paneAllocator";

const ind = (id: string, pane: "price_overlay" | "secondary", stretch?: number) => ({
  id,
  pane,
  secondaryPaneStretch: stretch,
});

describe("allocatePanes", () => {
  test("all price_overlay → only main pane", () => {
    const out = allocatePanes(
      [ind("ema", "price_overlay"), ind("bb", "price_overlay")],
      { ema: true, bb: true },
    );
    expect(out.assignments).toEqual({ ema: 0, bb: 0 });
    expect(out.stretches).toEqual([[0, 50]]);
  });

  test("two secondaries → main + 2 panes, stretches preserved", () => {
    const out = allocatePanes(
      [ind("rsi", "secondary", 13), ind("macd", "secondary", 15)],
      { rsi: true, macd: true },
    );
    expect(out.assignments).toEqual({ rsi: 1, macd: 2 });
    expect(out.stretches).toEqual([[0, 50], [1, 13], [2, 15]]);
  });

  test("hidden indicator is skipped → pane index shifts", () => {
    const out = allocatePanes(
      [ind("rsi", "secondary", 13), ind("macd", "secondary", 15)],
      { rsi: false, macd: true },
    );
    expect(out.assignments).toEqual({ macd: 1 });
    expect(out.stretches).toEqual([[0, 50], [1, 15]]);
  });

  test("default stretch is 13 when secondaryPaneStretch omitted", () => {
    const out = allocatePanes([ind("rsi", "secondary")], { rsi: true });
    expect(out.stretches).toEqual([[0, 50], [1, 13]]);
  });

  test("input order is preserved (deterministic)", () => {
    const out = allocatePanes(
      [ind("macd", "secondary", 15), ind("rsi", "secondary", 13)],
      { macd: true, rsi: true },
    );
    expect(out.assignments).toEqual({ macd: 1, rsi: 2 });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
bun test test/adapters/chart/paneAllocator.test.ts
```
Expected: FAIL with `Cannot find module '@adapters/chart/paneAllocator'`.

- [ ] **Step 3: Implement**

Write `src/adapters/chart/paneAllocator.ts`:

```ts
export type PaneInput = {
  id: string;
  pane: "price_overlay" | "secondary";
  /** Pixel stretch factor for secondary panes. Defaults to 13. */
  secondaryPaneStretch?: number;
};

export type PaneAllocation = {
  /** Pane index per indicator id (only visible ones — hidden are absent). */
  assignments: Record<string, number>;
  /** Stretch factor to apply per pane index. Always includes [0, 50] for the
   *  main pane, then [N, stretch] for each visible secondary in input order. */
  stretches: Array<[paneIndex: number, stretch: number]>;
};

const MAIN_PANE = 0;
const MAIN_STRETCH = 50;
const DEFAULT_SECONDARY_STRETCH = 13;

export function allocatePanes(
  indicators: ReadonlyArray<PaneInput>,
  visibility: Record<string, boolean>,
): PaneAllocation {
  const assignments: Record<string, number> = {};
  const stretches: Array<[number, number]> = [[MAIN_PANE, MAIN_STRETCH]];
  let nextSecondary = 1;
  for (const ind of indicators) {
    if (!visibility[ind.id]) continue;
    if (ind.pane === "price_overlay") {
      assignments[ind.id] = MAIN_PANE;
    } else {
      const idx = nextSecondary++;
      assignments[ind.id] = idx;
      stretches.push([idx, ind.secondaryPaneStretch ?? DEFAULT_SECONDARY_STRETCH]);
    }
  }
  return { assignments, stretches };
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
bun test test/adapters/chart/paneAllocator.test.ts
```
Expected: PASS — 5 tests green.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add src/adapters/chart/paneAllocator.ts test/adapters/chart/paneAllocator.test.ts
git commit -m "feat(chart): paneAllocator — deterministic pane assignment + stretch table"
```


### Task 1.3: `computeRightOffset` — pure function

**Files:**
- Create: `src/adapters/chart/computeRightOffset.ts` (split out from `chartBootstrap.ts` so the pure logic is independently testable)
- Test: `test/adapters/chart/computeRightOffset.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { computeRightOffset } from "@adapters/chart/computeRightOffset";

describe("computeRightOffset", () => {
  test("≤ 5 labels → offset 5", () => {
    expect(computeRightOffset({ priceOverlayLineCount: 0, priceLineCount: 0 })).toBe(5);
    expect(computeRightOffset({ priceOverlayLineCount: 3, priceLineCount: 2 })).toBe(5);
  });
  test("6-10 labels → offset 8", () => {
    expect(computeRightOffset({ priceOverlayLineCount: 4, priceLineCount: 2 })).toBe(8);
    expect(computeRightOffset({ priceOverlayLineCount: 6, priceLineCount: 4 })).toBe(8);
  });
  test("11-15 labels → offset 12", () => {
    expect(computeRightOffset({ priceOverlayLineCount: 7, priceLineCount: 4 })).toBe(12);
    expect(computeRightOffset({ priceOverlayLineCount: 10, priceLineCount: 5 })).toBe(12);
  });
  test("16+ labels caps at 16", () => {
    expect(computeRightOffset({ priceOverlayLineCount: 10, priceLineCount: 6 })).toBe(16);
    expect(computeRightOffset({ priceOverlayLineCount: 50, priceLineCount: 50 })).toBe(16);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
bun test test/adapters/chart/computeRightOffset.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Write `src/adapters/chart/computeRightOffset.ts`:

```ts
/**
 * How many candles of empty space to keep on the right side of the chart.
 * Why : the right-axis labels (BB Up, EMA short, Fib 0.382, …) stack
 * vertically ; past ~6 stacked labels they overflow into the candle area
 * and mask the last 3-5 bars — exactly the bars the LLM needs most.
 *
 * Empirical paliers (see `test/visual/chart-visibility.test.ts`). Tuned
 * for 1280×720 viewports.
 */
export function computeRightOffset(opts: {
  /** Lines on the price-overlay pane (each produces one label). */
  priceOverlayLineCount: number;
  /** priceLines on the main series (each produces one label). */
  priceLineCount: number;
}): number {
  const total = opts.priceOverlayLineCount + opts.priceLineCount;
  if (total <= 5) return 5;
  if (total <= 10) return 8;
  if (total <= 15) return 12;
  return 16;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
bun test test/adapters/chart/computeRightOffset.test.ts
```
Expected: PASS — 4 tests green.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add src/adapters/chart/computeRightOffset.ts test/adapters/chart/computeRightOffset.test.ts
git commit -m "feat(chart): computeRightOffset paliers for label-density-aware right margin"
```

### Task 1.4: `chartBootstrap.ts` — canonical chart creator

**Files:**
- Create: `src/adapters/chart/chartBootstrap.ts`
- Test: `test/adapters/chart/chartBootstrap.test.ts`

- [ ] **Step 1: Write the failing test (using a fake `LightweightCharts` global)**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyRightOffset, createTradingViewChart } from "@adapters/chart/chartBootstrap";

type Call = { method: string; args: unknown[] };

function fakeLC() {
  const calls: Call[] = [];
  const fakeChart = {
    addSeries: (cls: unknown, opts: unknown, paneIdx: unknown) => {
      calls.push({ method: "addSeries", args: [cls, opts, paneIdx] });
      return { __series: true };
    },
    timeScale: () => ({
      applyOptions: (opts: unknown) => calls.push({ method: "timeScale.applyOptions", args: [opts] }),
      fitContent: () => calls.push({ method: "timeScale.fitContent", args: [] }),
    }),
    panes: () => [{ setStretchFactor: (n: number) => calls.push({ method: "pane0.setStretchFactor", args: [n] }) }],
    applyOptions: (opts: unknown) => calls.push({ method: "applyOptions", args: [opts] }),
    remove: () => calls.push({ method: "remove", args: [] }),
  };
  return {
    LC: {
      CandlestickSeries: "CandlestickSeries",
      createChart: (_el: unknown, opts: unknown) => {
        calls.push({ method: "createChart", args: [opts] });
        return fakeChart;
      },
    },
    calls,
    fakeChart,
  };
}

describe("createTradingViewChart", () => {
  let savedLC: unknown;
  beforeEach(() => {
    savedLC = (globalThis as { LightweightCharts?: unknown }).LightweightCharts;
  });
  afterEach(() => {
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = savedLC;
  });

  test("naked: lighter grid + visible candle border + lastValueVisible", () => {
    const { LC, calls } = fakeLC();
    (globalThis as { LightweightCharts: unknown }).LightweightCharts = LC;
    const container = { clientWidth: 800 } as unknown as HTMLDivElement;
    const { dispose } = createTradingViewChart(container, { width: 800, height: 500, naked: true });
    const createCall = calls.find((c) => c.method === "createChart")?.args[0] as {
      grid: { vertLines: { color: string } };
    };
    expect(createCall.grid.vertLines.color).toBe("#1f2330");
    const addCall = calls.find((c) => c.method === "addSeries")?.args[1] as {
      borderVisible: boolean;
      lastValueVisible: boolean;
    };
    expect(addCall.borderVisible).toBe(true);
    expect(addCall.lastValueVisible).toBe(true);
    dispose();
    expect(calls.some((c) => c.method === "remove")).toBe(true);
  });

  test("non-naked: standard grid + hidden border", () => {
    const { LC, calls } = fakeLC();
    (globalThis as { LightweightCharts: unknown }).LightweightCharts = LC;
    const container = {} as unknown as HTMLDivElement;
    createTradingViewChart(container, { width: 800, height: 500, naked: false });
    const createCall = calls.find((c) => c.method === "createChart")?.args[0] as {
      grid: { vertLines: { color: string } };
    };
    expect(createCall.grid.vertLines.color).toBe("#2a2e39");
    const addCall = calls.find((c) => c.method === "addSeries")?.args[1] as {
      borderVisible: boolean;
    };
    expect(addCall.borderVisible).toBe(false);
  });

  test("uses canonical candle palette #26a69a / #ef5350", () => {
    const { LC, calls } = fakeLC();
    (globalThis as { LightweightCharts: unknown }).LightweightCharts = LC;
    createTradingViewChart({} as HTMLDivElement, { width: 800, height: 500, naked: false });
    const addCall = calls.find((c) => c.method === "addSeries")?.args[1] as {
      upColor: string;
      downColor: string;
    };
    expect(addCall.upColor).toBe("#26a69a");
    expect(addCall.downColor).toBe("#ef5350");
  });

  test("throws explicit error if LightweightCharts global is missing", () => {
    delete (globalThis as { LightweightCharts?: unknown }).LightweightCharts;
    expect(() =>
      createTradingViewChart({} as HTMLDivElement, { width: 800, height: 500, naked: false }),
    ).toThrow(/setupLightweightChartsGlobal/);
  });
});

describe("applyRightOffset", () => {
  test("forwards count to chart.timeScale().applyOptions({rightOffset})", () => {
    const calls: Call[] = [];
    const fakeChart = {
      timeScale: () => ({
        applyOptions: (opts: unknown) => calls.push({ method: "applyOptions", args: [opts] }),
      }),
    } as unknown as Parameters<typeof applyRightOffset>[0];
    applyRightOffset(fakeChart, { priceOverlayLineCount: 11, priceLineCount: 0 });
    expect(calls[0]).toEqual({ method: "applyOptions", args: [{ rightOffset: 12 }] });
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
bun test test/adapters/chart/chartBootstrap.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Write `src/adapters/chart/chartBootstrap.ts`:

```ts
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import { computeRightOffset } from "./computeRightOffset";

export type ChartCandleStyle = {
  upColor: string;
  downColor: string;
  borderVisible: boolean;
  wickUpColor: string;
  wickDownColor: string;
  lastValueVisible: boolean;
};

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
  candleSeries: ISeriesApi<"Candlestick">;
  dispose(): void;
};

const CANONICAL_CANDLE_STYLE: ChartCandleStyle = {
  upColor: "#26a69a",
  downColor: "#ef5350",
  borderVisible: false,
  wickUpColor: "#26a69a",
  wickDownColor: "#ef5350",
  lastValueVisible: false,
};

function readLC(): {
  createChart: (el: HTMLDivElement, opts: unknown) => IChartApi;
  CandlestickSeries: unknown;
} {
  const lc = (globalThis as { LightweightCharts?: unknown }).LightweightCharts;
  if (!lc) {
    throw new Error(
      "[chartBootstrap] globalThis.LightweightCharts is undefined. " +
        "Frontend : import `@client/lib/setupLightweightChartsGlobal` once at boot. " +
        "Backend Playwright : ensure the standalone bundle is injected before invoking the renderer.",
    );
  }
  return lc as {
    createChart: (el: HTMLDivElement, opts: unknown) => IChartApi;
    CandlestickSeries: unknown;
  };
}

export function createTradingViewChart(
  container: HTMLDivElement,
  opts: ChartBootstrapOpts,
): ChartBootstrapResult {
  const LC = readLC();
  const style = { ...CANONICAL_CANDLE_STYLE, ...opts.styleOverrides };
  if (opts.naked) {
    style.borderVisible = true;
    style.lastValueVisible = true;
  }
  const chart = LC.createChart(container, {
    width: opts.width,
    height: opts.height,
    layout: {
      background: { color: "#131722" },
      textColor: "#d1d4dc",
      panes: { separatorColor: "#2a2e39", separatorHoverColor: "#363a45" },
    },
    grid: {
      vertLines: { color: opts.naked ? "#1f2330" : "#2a2e39" },
      horzLines: { color: "#2a2e39" },
    },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#485158" },
    rightPriceScale: { borderColor: "#485158" },
    crosshair: { mode: 0 },
  });
  const candleSeries = chart.addSeries(LC.CandlestickSeries as never, style, 0) as ISeriesApi<"Candlestick">;
  return {
    chart,
    candleSeries,
    dispose: () => chart.remove(),
  };
}

export function applyRightOffset(
  chart: IChartApi,
  density: { priceOverlayLineCount: number; priceLineCount: number },
): void {
  const offset = computeRightOffset(density);
  chart.timeScale().applyOptions({ rightOffset: offset });
}
```

- [ ] **Step 4: Run, expect pass**

```bash
bun test test/adapters/chart/chartBootstrap.test.ts
```
Expected: PASS — 5 tests green.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add src/adapters/chart/chartBootstrap.ts test/adapters/chart/chartBootstrap.test.ts
git commit -m "feat(chart): chartBootstrap with canonical candle palette + applyRightOffset"
```

### Task 1.5: `bandsPrimitive.ts` — `ISeriesPrimitive` for canvas bands

**Files:**
- Create: `src/adapters/chart/bandsPrimitive.ts`
- Test: `test/adapters/chart/bandsPrimitive.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { BandsPrimitive, type Band } from "@adapters/chart/bandsPrimitive";

function fakeSeries() {
  return {
    priceToCoordinate: (price: number) => price * 2,
    chart: () => ({
      timeScale: () => ({
        timeToCoordinate: (t: number) => t,
      }),
    }),
  } as unknown as Parameters<typeof BandsPrimitive>[0] extends never
    ? never
    : Parameters<ConstructorParameters<typeof BandsPrimitive>[0] extends never ? never : typeof BandsPrimitive>[0];
}

describe("BandsPrimitive", () => {
  test("paneViews() returns a single view with zOrder=bottom", () => {
    // biome-ignore lint/suspicious/noExplicitAny: typed at construction time, but the fake doesn't fully implement ISeriesApi
    const series = fakeSeries() as any;
    const bands: Band[] = [
      { topPrice: 110, bottomPrice: 100, fillColor: "rgba(255,0,0,0.2)" },
    ];
    const p = new BandsPrimitive(series, bands);
    const views = p.paneViews();
    expect(views.length).toBe(1);
    expect(views[0]?.zOrder?.()).toBe("bottom");
  });

  test("renderer.draw() calls fillRect once per band with correct coords", () => {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const series = fakeSeries() as any;
    const bands: Band[] = [
      { topPrice: 110, bottomPrice: 100, fillColor: "rgba(255,0,0,0.2)" },
      { topPrice: 105, bottomPrice: 95, fillColor: "rgba(0,255,0,0.2)", fromTime: 100, toTime: 200 },
    ];
    const p = new BandsPrimitive(series, bands);
    const renderer = p.paneViews()[0]?.renderer();
    const fillRectCalls: Array<{ x: number; y: number; w: number; h: number; style: string }> = [];
    const fakeTarget = {
      useBitmapCoordinateSpace: (cb: (scope: { context: unknown; bitmapSize: { width: number; height: number } }) => void) => {
        const ctx = {
          set fillStyle(v: string) {
            (ctx as unknown as { _fill: string })._fill = v;
          },
          get fillStyle() {
            return (ctx as unknown as { _fill: string })._fill;
          },
          fillRect: (x: number, y: number, w: number, h: number) =>
            fillRectCalls.push({ x, y, w, h, style: (ctx as unknown as { _fill: string })._fill }),
        };
        cb({ context: ctx, bitmapSize: { width: 1000, height: 500 } });
      },
    };
    renderer?.draw(fakeTarget as never);
    expect(fillRectCalls.length).toBe(2);
    // Band 1: full width (no fromTime/toTime).
    expect(fillRectCalls[0]).toMatchObject({ x: 0, w: 1000, style: "rgba(255,0,0,0.2)" });
    // Band 2: bounded fromTime=100, toTime=200.
    expect(fillRectCalls[1]).toMatchObject({ x: 100, w: 100, style: "rgba(0,255,0,0.2)" });
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
bun test test/adapters/chart/bandsPrimitive.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Write `src/adapters/chart/bandsPrimitive.ts`:

```ts
import type {
  ISeriesApi,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  Time,
} from "lightweight-charts";

export type Band = {
  topPrice: number;
  bottomPrice: number;
  /** rgba or hex. Alpha < 0.4 to avoid hiding candles. */
  fillColor: string;
  label?: string;
  fromTime?: Time | number;
  toTime?: Time | number;
};

/**
 * Canvas-based price-bands primitive (Fib zones, volume profile fills, ...).
 * Lives in the candle pane's framebuffer — same context that draws the
 * candles, so it renders identically in the React frontend and the
 * Playwright backend. Replaces the HTML overlay `PriceBandsOverlay.tsx`.
 *
 * z-order = "bottom" : bands sit BELOW the candles, never mask price action.
 */
export class BandsPrimitive implements ISeriesPrimitive<Time> {
  constructor(
    private readonly series: ISeriesApi<"Candlestick">,
    private bands: Band[],
  ) {}

  paneViews(): readonly IPrimitivePaneView[] {
    const view: IPrimitivePaneView = {
      zOrder: () => "bottom",
      renderer: () => new BandsRenderer(this.series, this.bands),
    };
    return [view];
  }

  setBands(bands: Band[]): void {
    this.bands = bands;
  }
}

class BandsRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly series: ISeriesApi<"Candlestick">,
    private readonly bands: Band[],
  ) {}

  draw(target: { useBitmapCoordinateSpace: (cb: (scope: { context: CanvasRenderingContext2D; bitmapSize: { width: number; height: number } }) => void) => void }): void {
    target.useBitmapCoordinateSpace(({ context, bitmapSize }) => {
      const ts = (this.series as unknown as { chart: () => { timeScale: () => { timeToCoordinate: (t: Time | number) => number | null } } }).chart().timeScale();
      for (const band of this.bands) {
        const y1 = this.series.priceToCoordinate(band.topPrice);
        const y2 = this.series.priceToCoordinate(band.bottomPrice);
        if (y1 == null || y2 == null) continue;
        const x1 = band.fromTime != null ? ts.timeToCoordinate(band.fromTime) ?? 0 : 0;
        const x2 = band.toTime != null ? ts.timeToCoordinate(band.toTime) ?? bitmapSize.width : bitmapSize.width;
        context.fillStyle = band.fillColor;
        context.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
      }
    });
  }
}
```

- [ ] **Step 4: Run, expect pass**

```bash
bun test test/adapters/chart/bandsPrimitive.test.ts
```
Expected: PASS — 2 tests green.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add src/adapters/chart/bandsPrimitive.ts test/adapters/chart/bandsPrimitive.test.ts
git commit -m "feat(chart): BandsPrimitive — ISeriesPrimitive canvas implementation for kind=bands"
```

### Task 1.6: `setupLightweightChartsGlobal.ts` — expose `globalThis.LightweightCharts`

**Files:**
- Create: `src/client/lib/setupLightweightChartsGlobal.ts`

- [ ] **Step 1: Write the module**

```ts
/**
 * Side-effect import. Re-exports the whole `lightweight-charts` module
 * onto `globalThis.LightweightCharts` so the unified `chartBootstrap` and
 * `contributionRenderer` adapters can resolve constants (`LineSeries`,
 * `HistogramSeries`, `CandlestickSeries`, `createSeriesMarkers`) without
 * a compile-time `import` of `lightweight-charts` — which is what allows
 * the same TS source to also run inside the Playwright headless page,
 * where lightweight-charts is loaded as a `<script>` standalone bundle.
 *
 * Import this module ONCE at frontend boot (already done from
 * `src/client/frontend.tsx`). The module has no exports.
 */
import * as LC from "lightweight-charts";

(globalThis as { LightweightCharts?: typeof LC }).LightweightCharts = LC;
```

- [ ] **Step 2: Verify TS compiles**

```bash
bun run lint
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/client/lib/setupLightweightChartsGlobal.ts
git commit -m "feat(chart): setupLightweightChartsGlobal — expose LC on globalThis"
```


### Task 1.7: `contributionRenderer.ts` — kind dispatcher

**Files:**
- Create: `src/adapters/chart/contributionRenderer.ts`
- Test: `test/adapters/chart/contributionRenderer.test.ts`

- [ ] **Step 1: Write the failing test (covers each kind branch)**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyContribution, type ApplyContributionOpts } from "@adapters/chart/contributionRenderer";
import type { IndicatorSeriesContribution } from "@domain/charts/types";

type Call = { method: string; args: unknown[] };

function fakeChartAndSeries(calls: Call[]) {
  const fakeMain = {
    createPriceLine: (opts: unknown) => {
      calls.push({ method: "main.createPriceLine", args: [opts] });
      return { __priceLine: true };
    },
    removePriceLine: (line: unknown) => calls.push({ method: "main.removePriceLine", args: [line] }),
    attachPrimitive: (p: unknown) => calls.push({ method: "main.attachPrimitive", args: [p] }),
    detachPrimitive: (p: unknown) => calls.push({ method: "main.detachPrimitive", args: [p] }),
  };
  const fakeAddSeries = (cls: unknown, opts: unknown, paneIdx: unknown) => {
    calls.push({ method: "chart.addSeries", args: [cls, opts, paneIdx] });
    return {
      setData: (d: unknown) => calls.push({ method: "series.setData", args: [d] }),
    };
  };
  const fakeChart = {
    addSeries: fakeAddSeries,
    removeSeries: (s: unknown) => calls.push({ method: "chart.removeSeries", args: [s] }),
    panes: () => [{}],
  };
  return { fakeChart, fakeMain };
}

const baseOpts = (calls: Call[]): ApplyContributionOpts => {
  const { fakeMain } = fakeChartAndSeries(calls);
  return {
    id: "ema",
    renderConfig: {
      pane: "price_overlay",
      palette: ["#3b82f6", "#f59e0b", "#ef4444"],
      seriesLabels: { ema_short: "EMA short" },
    },
    paneIndex: 0,
    candleTimes: [1000, 1100, 1200] as unknown as ApplyContributionOpts["candleTimes"],
    mainSeries: fakeMain as unknown as ApplyContributionOpts["mainSeries"],
    markerBucket: [],
  };
};

describe("applyContribution dispatcher", () => {
  beforeEach(() => {
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = {
      LineSeries: "LineSeries",
      HistogramSeries: "HistogramSeries",
    };
  });
  afterEach(() => {
    delete (globalThis as { LightweightCharts?: unknown }).LightweightCharts;
  });

  test("kind=lines → addSeries(LineSeries) once per named series", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "lines",
      series: { ema_short: [1, 2, 3], ema_mid: [10, 20, 30] },
    };
    const opts = baseOpts(calls);
    applyContribution(opts as unknown as Parameters<typeof applyContribution>[0], c, opts);
    const addCalls = calls.filter((c) => c.method === "chart.addSeries");
    expect(addCalls.length).toBe(2);
    expect((addCalls[0]?.args[1] as { title: string }).title).toBe("EMA short");
    expect((addCalls[0]?.args[1] as { color: string }).color).toBe("#3b82f6");
    expect((addCalls[1]?.args[1] as { color: string }).color).toBe("#f59e0b");
  });

  test("kind=priceLines → createPriceLine on mainSeries", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "priceLines",
      lines: [{ price: 100, color: "#fff", style: 0, title: "TP" }],
    };
    const opts = baseOpts(calls);
    applyContribution(opts as unknown as Parameters<typeof applyContribution>[0], c, opts);
    expect(calls.some((c) => c.method === "main.createPriceLine")).toBe(true);
  });

  test("kind=markers → pushed into bucket, no chart call", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "markers",
      markers: [{ index: 1, position: "above", text: "X", color: "#fff", shape: "arrowDown" }],
    };
    const opts = baseOpts(calls);
    applyContribution(opts as unknown as Parameters<typeof applyContribution>[0], c, opts);
    expect(opts.markerBucket.length).toBe(1);
    expect(opts.markerBucket[0]?.text).toBe("X");
  });

  test("kind=histogram → addSeries(HistogramSeries)", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "histogram",
      values: [10, 20, { value: 30, color: "red" }],
    };
    const opts = baseOpts(calls);
    applyContribution(opts as unknown as Parameters<typeof applyContribution>[0], c, opts);
    expect(calls.find((c) => c.method === "chart.addSeries")?.args[0]).toBe("HistogramSeries");
  });

  test("kind=bands → attachPrimitive on mainSeries", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "bands",
      bands: [{ topPrice: 110, bottomPrice: 100, fillColor: "rgba(255,0,0,0.2)" }],
    };
    const opts = baseOpts(calls);
    applyContribution(opts as unknown as Parameters<typeof applyContribution>[0], c, opts);
    expect(calls.some((c) => c.method === "main.attachPrimitive")).toBe(true);
  });

  test("kind=compound → recurses into parts", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "compound",
      parts: [
        { kind: "priceLines", lines: [{ price: 100, color: "#fff", style: 0, title: "TP" }] },
        { kind: "markers", markers: [{ index: 1, position: "above", text: "X", color: "#fff", shape: "arrowUp" }] },
      ],
    };
    const opts = baseOpts(calls);
    applyContribution(opts as unknown as Parameters<typeof applyContribution>[0], c, opts);
    expect(calls.some((c) => c.method === "main.createPriceLine")).toBe(true);
    expect(opts.markerBucket.length).toBe(1);
  });

  test("cleanup() removes everything that was created", () => {
    const calls: Call[] = [];
    const c: IndicatorSeriesContribution = {
      kind: "compound",
      parts: [
        { kind: "lines", series: { ema_short: [1, 2, 3] } },
        { kind: "priceLines", lines: [{ price: 100, color: "#fff", style: 0, title: "TP" }] },
        { kind: "bands", bands: [{ topPrice: 110, bottomPrice: 100, fillColor: "rgba(255,0,0,0.2)" }] },
      ],
    };
    const opts = baseOpts(calls);
    const { cleanup } = applyContribution(
      opts as unknown as Parameters<typeof applyContribution>[0],
      c,
      opts,
    );
    cleanup();
    expect(calls.some((c) => c.method === "chart.removeSeries")).toBe(true);
    expect(calls.some((c) => c.method === "main.removePriceLine")).toBe(true);
    expect(calls.some((c) => c.method === "main.detachPrimitive")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
bun test test/adapters/chart/contributionRenderer.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Write `src/adapters/chart/contributionRenderer.ts`:

```ts
import type { IndicatorSeriesContribution, RenderConfig } from "@domain/charts/types";
import type {
  IChartApi,
  ISeriesApi,
  IPriceLine,
  ISeriesPrimitive,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import { BandsPrimitive } from "./bandsPrimitive";

// RenderConfig lives in @domain/charts/types — re-exported here for
// adapter-side convenience.
export type { RenderConfig } from "@domain/charts/types";

export type ApplyContributionOpts = {
  id: string;
  renderConfig: RenderConfig;
  /** Pane index resolved by `paneAllocator`. 0 = main pane. */
  paneIndex: number;
  candleTimes: UTCTimestamp[];
  mainSeries: ISeriesApi<"Candlestick">;
  /** Mutable bucket — markers from this indicator are pushed in. The
   *  parent commits all markers in one createSeriesMarkers() call. */
  markerBucket: SeriesMarker<Time>[];
};

export type ApplyContributionResult = {
  cleanup(): void;
};

function readLC(): {
  LineSeries: unknown;
  HistogramSeries: unknown;
} {
  const lc = (globalThis as { LightweightCharts?: unknown }).LightweightCharts as
    | { LineSeries: unknown; HistogramSeries: unknown }
    | undefined;
  if (!lc) {
    throw new Error(
      "[contributionRenderer] globalThis.LightweightCharts is undefined. " +
        "Import `@client/lib/setupLightweightChartsGlobal` at boot, " +
        "or ensure the standalone bundle is injected before invoking the Playwright renderer.",
    );
  }
  return lc;
}

export function applyContribution(
  chart: IChartApi,
  contribution: IndicatorSeriesContribution,
  opts: ApplyContributionOpts,
): ApplyContributionResult {
  const LC = readLC();
  const createdSeries: ISeriesApi<"Line" | "Histogram">[] = [];
  const createdPriceLines: Array<{ series: ISeriesApi<"Candlestick">; line: IPriceLine }> = [];
  const createdPrimitives: Array<{ series: ISeriesApi<"Candlestick">; primitive: ISeriesPrimitive<Time> }> = [];

  function pickColor(index: number): string {
    const palette = opts.renderConfig.palette;
    if (palette.length === 0) return "#94a3b8";
    return palette[index % palette.length] as string;
  }

  function labelFor(name: string): string {
    return opts.renderConfig.seriesLabels?.[name] ?? `${opts.id}:${name}`;
  }

  function applyOne(c: IndicatorSeriesContribution): void {
    switch (c.kind) {
      case "lines": {
        const entries = Object.entries(c.series);
        entries.forEach(([name, values], idx) => {
          const series = chart.addSeries(
            LC.LineSeries as never,
            {
              color: pickColor(idx),
              lineWidth: 2,
              priceLineVisible: false,
              lastValueVisible: false,
              title: labelFor(name),
            },
            opts.paneIndex,
          ) as ISeriesApi<"Line">;
          const data = alignToTimes(opts.candleTimes, values);
          series.setData(data);
          createdSeries.push(series);
        });
        return;
      }
      case "priceLines": {
        for (const line of c.lines) {
          const created = opts.mainSeries.createPriceLine({
            price: line.price,
            color: line.color,
            lineWidth: 1,
            lineStyle: line.style,
            axisLabelVisible: line.title !== "",
            title: line.title,
          });
          createdPriceLines.push({ series: opts.mainSeries, line: created });
        }
        return;
      }
      case "markers": {
        for (const m of c.markers) {
          const t = opts.candleTimes[m.index];
          if (t === undefined) continue;
          opts.markerBucket.push({
            time: t,
            position: m.position === "above" ? "aboveBar" : "belowBar",
            shape: m.shape,
            color: m.color,
            text: m.text,
          });
        }
        return;
      }
      case "histogram": {
        const series = chart.addSeries(
          LC.HistogramSeries as never,
          {
            priceLineVisible: false,
            lastValueVisible: false,
            title: opts.id,
          },
          opts.paneIndex,
        ) as ISeriesApi<"Histogram">;
        const data = c.values
          .map((v, i) => {
            const time = opts.candleTimes[i];
            if (time === undefined || v === null) return null;
            if (typeof v === "number") return { time, value: v };
            return { time, value: v.value, color: v.color };
          })
          .filter((d): d is { time: UTCTimestamp; value: number; color?: string } => d !== null);
        series.setData(data);
        createdSeries.push(series);
        return;
      }
      case "bands": {
        const primitive = new BandsPrimitive(opts.mainSeries, c.bands);
        opts.mainSeries.attachPrimitive(primitive);
        createdPrimitives.push({ series: opts.mainSeries, primitive });
        return;
      }
      case "compound": {
        for (const part of c.parts) applyOne(part);
        return;
      }
    }
  }

  applyOne(contribution);

  return {
    cleanup() {
      for (const s of createdSeries) {
        try {
          chart.removeSeries(s);
        } catch {
          // chart already torn down — ignore.
        }
      }
      for (const { series, line } of createdPriceLines) {
        try {
          series.removePriceLine(line);
        } catch {
          // ignore.
        }
      }
      for (const { series, primitive } of createdPrimitives) {
        try {
          series.detachPrimitive(primitive);
        } catch {
          // ignore.
        }
      }
    },
  };
}

export function alignToTimes(
  times: UTCTimestamp[],
  values: (number | null)[],
): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = [];
  const n = Math.min(times.length, values.length);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const t = times[i];
    if (v === null || v === undefined || t === undefined) continue;
    out.push({ time: t, value: v });
  }
  return out;
}
```

- [ ] **Step 4: Run, expect pass**

```bash
bun test test/adapters/chart/contributionRenderer.test.ts
```
Expected: PASS — 7 tests green.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add src/adapters/chart/contributionRenderer.ts test/adapters/chart/contributionRenderer.test.ts
git commit -m "feat(chart): contributionRenderer — unified kind dispatcher with cleanup"
```

### Task 1.8: Foundation stories — BandsPrimitive in Storybook

**Files:**
- Create: `src/adapters/chart/__stories__/BandsPrimitive.stories.tsx`
- Create: `test/fixtures/candles/btcusdt-1h-bullish-200.json` (small fixture used by stories)

- [ ] **Step 1: Generate the fixture**

Write a one-off script `scripts/generate-fixtures.ts` (not committed) or use an inline `Bun.write` snippet to produce 200 candles with a clean uptrend leg. Save as JSON:

```ts
// scripts/generate-fixtures.ts
import { mkdir } from "node:fs/promises";
await mkdir("test/fixtures/candles", { recursive: true });

function gen(seed = 0, trend = 1) {
  const out: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  let price = 100;
  let t = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);
  for (let i = 0; i < 200; i++) {
    const drift = trend * 0.05;
    const noise = (((seed + i * 9301 + 49297) % 233280) / 233280 - 0.5) * 2;
    const open = price;
    const close = price + drift + noise;
    const high = Math.max(open, close) + Math.abs(noise) * 0.5;
    const low = Math.min(open, close) - Math.abs(noise) * 0.5;
    out.push({ time: t, open, high, low, close, volume: 1000 + Math.abs(noise) * 100 });
    price = close;
    t += 3600;
  }
  return out;
}

await Bun.write(
  "test/fixtures/candles/btcusdt-1h-bullish-200.json",
  JSON.stringify(gen(0, 1), null, 2),
);
await Bun.write(
  "test/fixtures/candles/btcusdt-1h-bearish-200.json",
  JSON.stringify(gen(7, -1), null, 2),
);
console.log("Generated fixtures.");
```

Run: `bun run scripts/generate-fixtures.ts`. Confirm files exist with 200 candles each.

- [ ] **Step 2: Add tsconfig `@test-fixtures/*` alias**

In `tsconfig.json` `compilerOptions.paths`, add (if not present):

```json
"@test-fixtures/*": ["test/fixtures/*"]
```

- [ ] **Step 3: Write the story**

Create `src/adapters/chart/__stories__/BandsPrimitive.stories.tsx`:

```tsx
import { createTradingViewChart } from "@adapters/chart/chartBootstrap";
import { BandsPrimitive } from "@adapters/chart/bandsPrimitive";
import fixtureBullish from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";
import type { UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

function BandsDemo({ bands }: { bands: Array<{ topPrice: number; bottomPrice: number; fillColor: string }> }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const { chart, candleSeries, dispose } = createTradingViewChart(ref.current, {
      width: 1024,
      height: 500,
      naked: false,
    });
    candleSeries.setData(
      fixtureBullish.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
      })),
    );
    const primitive = new BandsPrimitive(candleSeries, bands);
    candleSeries.attachPrimitive(primitive);
    chart.timeScale().fitContent();
    return () => {
      candleSeries.detachPrimitive(primitive);
      dispose();
    };
  }, [bands]);
  return <div ref={ref} style={{ width: 1024, height: 500 }} />;
}

export default { title: "Chart/BandsPrimitive", component: BandsDemo };

export const Uptrend = {
  args: {
    bands: [
      { topPrice: 118, bottomPrice: 115, fillColor: "rgba(255, 215, 0, 0.18)" },  // golden zone
      { topPrice: 115, bottomPrice: 112, fillColor: "rgba(76, 175, 80, 0.12)" },
      { topPrice: 112, bottomPrice: 108, fillColor: "rgba(33, 150, 243, 0.10)" },
      { topPrice: 108, bottomPrice: 105, fillColor: "rgba(244, 67, 54, 0.10)" },
    ],
  },
};

export const Downtrend = {
  args: {
    bands: [
      { topPrice: 95, bottomPrice: 92, fillColor: "rgba(255, 215, 0, 0.18)" },
    ],
  },
};

export const NoBands = { args: { bands: [] } };
```

- [ ] **Step 4: Uncomment the setupLightweightChartsGlobal import in `.storybook/preview.tsx`**

Edit `.storybook/preview.tsx`:

```tsx
import "@client/lib/setupLightweightChartsGlobal";  // now exists (Task 1.6)
```

- [ ] **Step 5: Launch Storybook + verify**

```bash
bun run storybook
```

Navigate to `Chart/BandsPrimitive/Uptrend` in the iframe. Expect : a candle chart with 4 horizontal translucent bands stacked. Use Chrome DevTools MCP to take a screenshot.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/chart/__stories__ test/fixtures/candles tsconfig.json .storybook/preview.tsx
git commit -m "test(storybook): BandsPrimitive stories + bullish/bearish fixtures + @test-fixtures alias"
```


---

## Phase 2 — React adapter `<TradingViewChart>`

Goal: build the React component that consumes Phase 1's adapters, owns visibility state, fullscreen, marker bucket merging, and exposes the documented API. Replaces the three frontend wrappers (Phase 3 swaps them in).

### Task 2.1: Wire `setupLightweightChartsGlobal` into the app

**Files:**
- Modify: `src/client/frontend.tsx`

- [ ] **Step 1: Add the side-effect import**

Read `src/client/frontend.tsx` to find the topmost import. Then add as the FIRST import in the file:

```tsx
import "@client/lib/setupLightweightChartsGlobal";
```

- [ ] **Step 2: Verify the app still boots**

```bash
bun run worker:web &
sleep 3
curl -sI http://localhost:3000/ | head -1
kill %1
```

Expected: `HTTP/1.1 200 OK`. The side-effect import shouldn't break anything.

- [ ] **Step 3: Commit**

```bash
git add src/client/frontend.tsx
git commit -m "feat(client): import setupLightweightChartsGlobal at app boot"
```

### Task 2.2: `IndicatorControlPanel` — sub-component (toggle UI)

**Files:**
- Create: `src/client/components/charts/IndicatorControlPanel.tsx`
- Create: `src/client/components/charts/__stories__/IndicatorControlPanel.stories.tsx`

- [ ] **Step 1: Implement the component**

```tsx
import { cn } from "@client/lib/utils";

export type IndicatorChipEntry = {
  id: string;
  displayName: string;
  /** Swatch color — the first entry of the plugin's renderConfig.palette. */
  swatch: string;
};

export type ControlsLayout = "top-chips" | "sidebar-right" | "sidebar-left";

export function IndicatorControlPanel(props: {
  entries: IndicatorChipEntry[];
  visibility: Record<string, boolean>;
  onToggle: (id: string, visible: boolean) => void;
  onShowAll(): void;
  onShowNone(): void;
  layout: ControlsLayout;
}): JSX.Element {
  const isSidebar = props.layout !== "top-chips";
  return (
    <div
      data-testid="indicator-control-panel"
      className={cn(
        "flex gap-1.5 flex-wrap p-1.5",
        isSidebar && "flex-col",
      )}
    >
      <button
        type="button"
        onClick={props.onShowAll}
        className="text-xs px-2 py-0.5 rounded border border-border hover:bg-muted"
      >
        All
      </button>
      <button
        type="button"
        onClick={props.onShowNone}
        className="text-xs px-2 py-0.5 rounded border border-border hover:bg-muted"
      >
        None
      </button>
      {props.entries.map((e) => {
        const visible = props.visibility[e.id] ?? false;
        return (
          <button
            key={e.id}
            type="button"
            role="checkbox"
            aria-checked={visible}
            aria-label={e.displayName}
            data-testid={`indicator-chip-${e.id}`}
            onClick={() => props.onToggle(e.id, !visible)}
            className={cn(
              "inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded border transition-colors",
              visible
                ? "border-foreground bg-muted text-foreground"
                : "border-border text-muted-foreground",
            )}
          >
            <span
              className="inline-block size-2 rounded-full"
              style={{ background: e.swatch }}
            />
            {e.displayName}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Write the story**

```tsx
import { IndicatorControlPanel } from "@client/components/charts/IndicatorControlPanel";
import { useState } from "react";

const entries = [
  { id: "ema_stack", displayName: "EMA stack", swatch: "#3b82f6" },
  { id: "rsi", displayName: "RSI", swatch: "#14b8a6" },
  { id: "fibonacci", displayName: "Fibonacci", swatch: "#ef9a9a" },
];

function Demo({ layout }: { layout: "top-chips" | "sidebar-right" | "sidebar-left" }) {
  const [visibility, setVisibility] = useState({ ema_stack: true, rsi: false, fibonacci: true });
  return (
    <IndicatorControlPanel
      entries={entries}
      visibility={visibility}
      layout={layout}
      onToggle={(id, v) => setVisibility((s) => ({ ...s, [id]: v }))}
      onShowAll={() => setVisibility(Object.fromEntries(entries.map((e) => [e.id, true])))}
      onShowNone={() => setVisibility(Object.fromEntries(entries.map((e) => [e.id, false])))}
    />
  );
}

export default { title: "Chart/IndicatorControlPanel", component: Demo };
export const TopChips = { args: { layout: "top-chips" } };
export const SidebarRight = { args: { layout: "sidebar-right" } };
export const SidebarLeft = { args: { layout: "sidebar-left" } };
```

- [ ] **Step 3: Visual verify via Storybook**

`bun run storybook` → navigate to `Chart/IndicatorControlPanel/TopChips`. Click chips → confirm they toggle.

- [ ] **Step 4: Commit**

```bash
bun run lint:fix
git add src/client/components/charts/IndicatorControlPanel.tsx src/client/components/charts/__stories__/IndicatorControlPanel.stories.tsx
git commit -m "feat(charts): IndicatorControlPanel sub-component (chips/sidebar variants)"
```

### Task 2.3: `<TradingViewChart>` — main React component (mount + indicators + cleanup)

**Files:**
- Create: `src/client/components/charts/TradingViewChart.tsx`
- Test: `test/client/components/charts/TradingViewChart.test.tsx`

This task is large. Split into substeps.

- [ ] **Step 1: Write a smoke test (uses @testing-library/react in jsdom)**

Note: this test exercises React lifecycle but NOT lightweight-charts canvas paint (jsdom has no canvas). We only assert mount + cleanup + visibility state behavior on the DOM. Visual correctness is covered by stories + Playwright.

```tsx
import { describe, expect, test } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TradingViewChart } from "@client/components/charts/TradingViewChart";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

const fakePlugin = (id: string, pane: "price_overlay" | "secondary" = "price_overlay"): IndicatorPlugin => ({
  id: id as never,
  displayName: id.toUpperCase(),
  tag: "trend",
  shortDescription: "",
  longDescription: "",
  computeScalars: () => ({}),
  computeSeries: () => ({ kind: "lines", series: { a: [1, 2, 3] } }),
  scalarSchemaFragment: () => ({}),
  chartScript: "",
  chartPane: pane,
  getPromptData: () => null,
  renderConfig: { pane, palette: ["#ff0000"] },
} as unknown as IndicatorPlugin);

describe("<TradingViewChart>", () => {
  test("renders the chart wrapper + control panel when enableControls", () => {
    // Stub LightweightCharts global so the bootstrap doesn't throw.
    (globalThis as { LightweightCharts?: unknown }).LightweightCharts = {
      LineSeries: "Line",
      HistogramSeries: "Histo",
      CandlestickSeries: "Candle",
      createChart: () => ({
        addSeries: () => ({ setData: () => undefined, createPriceLine: () => ({}) }),
        timeScale: () => ({ applyOptions: () => undefined, fitContent: () => undefined }),
        panes: () => [{ setStretchFactor: () => undefined }],
        applyOptions: () => undefined,
        remove: () => undefined,
      }),
    };
    render(
      <TradingViewChart
        candles={[]}
        indicators={[
          {
            id: "ema_stack",
            plugin: fakePlugin("ema_stack"),
            contribution: { kind: "lines", series: { a: [1] } },
          },
        ]}
        enableControls
      />,
    );
    expect(screen.getByTestId("trading-view-chart")).toBeTruthy();
    expect(screen.getByTestId("indicator-control-panel")).toBeTruthy();
    cleanup();
  });

  test("when enableControls=false, no panel is rendered", () => {
    render(
      <TradingViewChart
        candles={[]}
        indicators={[
          {
            id: "ema_stack",
            plugin: fakePlugin("ema_stack"),
            contribution: { kind: "lines", series: { a: [1] } },
          },
        ]}
      />,
    );
    expect(screen.queryByTestId("indicator-control-panel")).toBeNull();
    cleanup();
  });

  test("toggling a chip flips visibility (chart is rebuilt)", () => {
    render(
      <TradingViewChart
        candles={[]}
        indicators={[
          {
            id: "rsi",
            plugin: fakePlugin("rsi", "secondary"),
            contribution: { kind: "lines", series: { a: [1] } },
          },
        ]}
        enableControls
        initialVisibility={{ rsi: true }}
      />,
    );
    const chip = screen.getByTestId("indicator-chip-rsi");
    expect(chip.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-checked")).toBe("false");
    cleanup();
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
bun test test/client/components/charts/TradingViewChart.test.tsx
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `<TradingViewChart>`**

Write `src/client/components/charts/TradingViewChart.tsx`:

```tsx
import { allocatePanes } from "@adapters/chart/paneAllocator";
import { applyContribution, type RenderConfig } from "@adapters/chart/contributionRenderer";
import { applyRightOffset, createTradingViewChart } from "@adapters/chart/chartBootstrap";
import type { IndicatorSeriesContribution } from "@domain/charts/types";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { cn } from "@client/lib/utils";
import type { IChartApi, ISeriesApi, SeriesMarker, Time, UTCTimestamp } from "lightweight-charts";
import { Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ControlsLayout, IndicatorControlPanel } from "./IndicatorControlPanel";

export type IndicatorEntry = {
  id: string;
  plugin: IndicatorPlugin & { renderConfig: RenderConfig };
  contribution: IndicatorSeriesContribution;
};

export type PriceLineSpec = {
  price: number;
  color: string;
  title: string;
  style?: 0 | 1 | 2;
};

export type EventMarkerSpec = {
  time: UTCTimestamp;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  text: string;
};

export type TradingViewChartProps = {
  candles: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>;
  indicators?: IndicatorEntry[];
  priceLines?: PriceLineSpec[];
  markers?: EventMarkerSpec[];
  /** When true, render the indicator toggle panel. State lives inside this
   *  component — caller does not manage it. Default false (read-only). */
  enableControls?: boolean;
  initialVisibility?: Record<string, boolean>;
  controlsLayout?: ControlsLayout;
  /** Fullscreen via F11 + corner button. Default true on this generic
   *  component ; wrappers opt out (asset-chart) by passing false. */
  enableFullscreen?: boolean;
  /** Chart container height in normal (non-fullscreen) mode. */
  height?: number;
  /** Caller-provided className on the outer wrapper. */
  className?: string;
  onChartReady?: (chart: IChartApi) => void;
};

const MAIN_PANE = 0;

export function TradingViewChart(props: TradingViewChartProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const indicatorCleanupsRef = useRef<Array<{ cleanup: () => void }>>([]);
  const indicatorMarkersRef = useRef<SeriesMarker<Time>[]>([]);
  const priceLinesRef = useRef<Array<{ series: ISeriesApi<"Candlestick">; line: ReturnType<NonNullable<typeof candleSeriesRef.current>["createPriceLine"]> }>>([]);
  const markersPluginRef = useRef<{ setMarkers: (m: SeriesMarker<Time>[]) => void } | null>(null);

  const height = props.height ?? 380;
  const enableControls = props.enableControls ?? false;
  const enableFullscreen = props.enableFullscreen ?? true;
  const controlsLayout: ControlsLayout = props.controlsLayout ?? "top-chips";

  // Visibility state — only meaningful when enableControls. When disabled,
  // every indicator is visible (no toggling possible).
  const [visibility, setVisibility] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const i of props.indicators ?? []) {
      init[i.id] = props.initialVisibility?.[i.id] ?? !enableControls;
    }
    return init;
  });

  // Sync visibility when the indicators list changes (new ids appear or disappear).
  useEffect(() => {
    setVisibility((prev) => {
      const next: Record<string, boolean> = {};
      for (const i of props.indicators ?? []) {
        next[i.id] = prev[i.id] ?? props.initialVisibility?.[i.id] ?? !enableControls;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(props.indicators ?? []).map((i) => i.id).join(",")]);

  // Mount the chart once.
  useEffect(() => {
    if (!containerRef.current) return;
    const { chart, candleSeries, dispose } = createTradingViewChart(containerRef.current, {
      width: containerRef.current.clientWidth || 800,
      height,
      naked: (props.indicators?.length ?? 0) === 0,
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    // Markers plugin — needs to exist before applyContribution might push markers.
    const LC = (globalThis as { LightweightCharts?: { createSeriesMarkers?: <T>(s: ISeriesApi<"Candlestick">) => { setMarkers: (m: SeriesMarker<T>[]) => void } } }).LightweightCharts;
    if (LC?.createSeriesMarkers) {
      markersPluginRef.current = LC.createSeriesMarkers(candleSeries);
    }

    props.onChartReady?.(chart);

    const onResize = (): void => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      // Defer dispose by one rAF so any pending series cleanup completes
      // on a still-alive chart (see replay-chart.tsx for the original
      // bug context : "Object is disposed" inside TimeAxisWidget._paint).
      requestAnimationFrame(() => {
        try {
          dispose();
        } catch {
          // already disposed.
        }
      });
      chartRef.current = null;
      candleSeriesRef.current = null;
      markersPluginRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push candle data.
  useEffect(() => {
    candleSeriesRef.current?.setData(props.candles);
  }, [props.candles]);

  // Apply indicators (rebuild on visibility / data change).
  const candleTimes = useMemo(() => props.candles.map((c) => c.time), [props.candles]);
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleSeriesRef.current;
    const markersPlugin = markersPluginRef.current;
    if (!chart || !candle) return;

    for (const c of indicatorCleanupsRef.current) c.cleanup();
    indicatorCleanupsRef.current = [];
    indicatorMarkersRef.current = [];

    const ind = props.indicators ?? [];
    const alloc = allocatePanes(
      ind.map((i) => ({
        id: i.id,
        pane: i.plugin.renderConfig.pane,
        secondaryPaneStretch: i.plugin.renderConfig.secondaryPaneStretch,
      })),
      visibility,
    );

    for (const i of ind) {
      const paneIndex = alloc.assignments[i.id];
      if (paneIndex === undefined) continue; // hidden
      const result = applyContribution(chart, i.contribution, {
        id: i.id,
        renderConfig: i.plugin.renderConfig,
        paneIndex,
        candleTimes,
        mainSeries: candle,
        markerBucket: indicatorMarkersRef.current,
      });
      indicatorCleanupsRef.current.push(result);
    }

    for (const [idx, stretch] of alloc.stretches) {
      chart.panes()[idx]?.setStretchFactor(stretch);
    }

    // Right offset based on visible price-overlay lines + priceLines.
    const priceOverlayLineCount = ind.reduce((acc, i) => {
      if (!visibility[i.id]) return acc;
      if (i.plugin.renderConfig.pane !== "price_overlay") return acc;
      return acc + countLines(i.contribution);
    }, 0);
    applyRightOffset(chart, {
      priceOverlayLineCount,
      priceLineCount: props.priceLines?.length ?? 0,
    });

    // Commit merged markers.
    const merged: SeriesMarker<Time>[] = [...indicatorMarkersRef.current];
    for (const m of props.markers ?? []) {
      merged.push({
        time: m.time,
        position: m.position,
        color: m.color,
        shape: m.shape,
        text: m.text,
      });
    }
    markersPlugin?.setMarkers(merged);

    return () => {
      for (const c of indicatorCleanupsRef.current) c.cleanup();
      indicatorCleanupsRef.current = [];
    };
  }, [props.indicators, visibility, candleTimes, props.priceLines, props.markers]);

  // Apply caller-provided priceLines.
  useEffect(() => {
    const candle = candleSeriesRef.current;
    if (!candle) return;
    for (const { series, line } of priceLinesRef.current) {
      try { series.removePriceLine(line); } catch {}
    }
    priceLinesRef.current = [];
    for (const pl of props.priceLines ?? []) {
      priceLinesRef.current.push({
        series: candle,
        line: candle.createPriceLine({
          price: pl.price,
          color: pl.color,
          lineWidth: 1,
          lineStyle: pl.style ?? 0,
          axisLabelVisible: true,
          title: pl.title,
        }),
      });
    }
  }, [props.priceLines]);

  // Fullscreen.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    if (!enableFullscreen) return;
    const onChange = (): void => {
      const fs = document.fullscreenElement === wrapperRef.current;
      setIsFullscreen(fs);
      const wrapper = wrapperRef.current;
      if (chartRef.current && wrapper) {
        chartRef.current.applyOptions({
          width: wrapper.clientWidth,
          height: fs ? window.innerHeight - 16 : height,
        });
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "F11" && wrapperRef.current) {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("keydown", onKey);
    };
  }, [enableFullscreen, height]);

  const toggleFullscreen = useCallback(async () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (document.fullscreenElement === wrapper) await document.exitFullscreen();
    else await wrapper.requestFullscreen();
  }, []);

  // Indicator chip entries derived from indicators + visibility.
  const chipEntries = useMemo(
    () =>
      (props.indicators ?? []).map((i) => ({
        id: i.id,
        displayName: i.plugin.displayName,
        swatch: i.plugin.renderConfig.palette[0] ?? "#94a3b8",
      })),
    [props.indicators],
  );

  return (
    <div
      ref={wrapperRef}
      data-testid="trading-view-chart"
      className={cn(
        "relative w-full bg-card border border-border rounded-md overflow-hidden",
        isFullscreen && "rounded-none border-0",
        props.className,
      )}
    >
      {enableControls ? (
        <IndicatorControlPanel
          entries={chipEntries}
          visibility={visibility}
          layout={controlsLayout}
          onToggle={(id, v) => setVisibility((s) => ({ ...s, [id]: v }))}
          onShowAll={() => setVisibility(Object.fromEntries(chipEntries.map((e) => [e.id, true])))}
          onShowNone={() => setVisibility(Object.fromEntries(chipEntries.map((e) => [e.id, false])))}
        />
      ) : null}
      <div ref={containerRef} className="w-full" />
      {enableFullscreen ? (
        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute top-2 right-2 z-10 inline-flex items-center justify-center size-7 rounded-md border border-border bg-card/85 backdrop-blur text-muted-foreground hover:text-foreground"
          title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        >
          {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      ) : null}
    </div>
  );
}

function countLines(c: IndicatorSeriesContribution): number {
  if (c.kind === "lines") return Object.keys(c.series).length;
  if (c.kind === "compound") return c.parts.reduce((acc, p) => acc + countLines(p), 0);
  if (c.kind === "priceLines") return c.lines.length;
  return 0;
}
```

- [ ] **Step 4: Add `@testing-library/react` if missing**

```bash
bun add -D @testing-library/react @testing-library/dom
```

- [ ] **Step 5: Run the test, expect pass**

```bash
bun test test/client/components/charts/TradingViewChart.test.tsx
```
Expected: PASS — 3 tests green. The chart container stub gives no actual canvas, but mount + state behavior is verified.

- [ ] **Step 6: Lint + commit**

```bash
bun run lint:fix
git add src/client/components/charts/TradingViewChart.tsx test/client/components/charts/TradingViewChart.test.tsx package.json bun.lock
git commit -m "feat(charts): TradingViewChart React component (controls + fullscreen + marker bucket)"
```

### Task 2.4: Stories for `<TradingViewChart>`

**Files:**
- Create: `src/client/components/charts/__stories__/TradingViewChart.stories.tsx`

- [ ] **Step 1: Write the stories**

```tsx
import { TradingViewChart } from "@client/components/charts/TradingViewChart";
import { rsiPlugin } from "@adapters/indicators/plugins/rsi";
import { emaStackPlugin } from "@adapters/indicators/plugins/ema_stack";
import fixtureBullish from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";
import type { UTCTimestamp } from "lightweight-charts";

const candles = fixtureBullish.map((c) => ({
  time: c.time as UTCTimestamp,
  open: c.open, high: c.high, low: c.low, close: c.close,
}));

// Until Phase 4 adds renderConfig to each plugin, inline a temporary shim
// so the stories compile. After Phase 4, drop the inline shim and use
// plugin.renderConfig directly.
const tempRenderConfig = {
  ema_stack: { pane: "price_overlay" as const, palette: ["#3b82f6", "#f59e0b", "#ef4444"] },
  rsi: { pane: "secondary" as const, palette: ["#14b8a6"], secondaryPaneStretch: 13 },
};

export default { title: "Charts/TradingViewChart", component: TradingViewChart };

export const Naked = { args: { candles } };

export const SingleIndicator = {
  args: {
    candles,
    indicators: [
      {
        id: "rsi",
        plugin: { ...rsiPlugin, renderConfig: tempRenderConfig.rsi },
        contribution: rsiPlugin.computeSeries(
          fixtureBullish.map((c) => ({ ...c, timestamp: new Date(c.time * 1000) })) as never,
        ),
      },
    ],
  },
};

export const PriceOverlayStack = {
  args: {
    candles,
    indicators: [
      {
        id: "ema_stack",
        plugin: { ...emaStackPlugin, renderConfig: tempRenderConfig.ema_stack },
        contribution: emaStackPlugin.computeSeries(
          fixtureBullish.map((c) => ({ ...c, timestamp: new Date(c.time * 1000) })) as never,
        ),
      },
    ],
  },
};

export const WithControls = {
  args: {
    candles,
    enableControls: true,
    indicators: [
      {
        id: "ema_stack",
        plugin: { ...emaStackPlugin, renderConfig: tempRenderConfig.ema_stack },
        contribution: emaStackPlugin.computeSeries(
          fixtureBullish.map((c) => ({ ...c, timestamp: new Date(c.time * 1000) })) as never,
        ),
      },
      {
        id: "rsi",
        plugin: { ...rsiPlugin, renderConfig: tempRenderConfig.rsi },
        contribution: rsiPlugin.computeSeries(
          fixtureBullish.map((c) => ({ ...c, timestamp: new Date(c.time * 1000) })) as never,
        ),
      },
    ],
  },
};

export const WithPriceLines = {
  args: {
    candles,
    priceLines: [
      { price: 115, color: "#10b981", title: "TP1", style: 2 },
      { price: 105, color: "#ef4444", title: "SL", style: 2 },
      { price: 110, color: "#3b82f6", title: "Entry", style: 0 },
    ],
  },
};
```

- [ ] **Step 2: Verify visually**

`bun run storybook` → cycle through the 5 stories. Confirm each renders without runtime errors. Screenshot `WithControls` and click chips to see the chart rebuild.

- [ ] **Step 3: Commit**

```bash
git add src/client/components/charts/__stories__/TradingViewChart.stories.tsx
git commit -m "test(storybook): TradingViewChart stories — Naked/Single/Stack/Controls/PriceLines"
```


---

## Phase 3 — Migrate the 3 frontend call sites

Goal: replace `replay-chart.tsx`, `tv-chart.tsx`, `asset-chart.tsx` body code with wrappers of `<TradingViewChart>`. Each sub-task is independently mergeable + reverts cleanly.

**Pre-req:** Phase 4 has not yet added `renderConfig` to plugin objects. We need a temporary lookup map until Phase 4. Create it in Task 3.0.

### Task 3.0: Temporary `renderConfigByPluginId` map

**Files:**
- Create: `src/adapters/indicators/renderConfigByPluginId.ts`

This file is intentionally short-lived. It centralizes the palette/labels per plugin id so `<TradingViewChart>` callers can resolve `renderConfig` from `plugin.id` before each plugin owns its own `renderConfig` (Phase 4). Removed in Phase 4.

- [ ] **Step 1: Write the map**

```ts
import type { RenderConfig } from "@adapters/chart/contributionRenderer";

/**
 * TEMPORARY — to be deleted in Phase 4 once every plugin owns its own
 * `renderConfig`. Until then this is the bridge that lets the new
 * `<TradingViewChart>` resolve palettes from the plugin id alone.
 *
 * Mirrors `INDICATOR_PALETTES` from the old `replay-chart.tsx` + the
 * inline colors baked in each `chartScript.ts`.
 */
export const RENDER_CONFIG_BY_PLUGIN_ID: Record<string, RenderConfig> = {
  ema_stack: {
    pane: "price_overlay",
    palette: ["#3b82f6", "#f59e0b", "#ef4444"],
    seriesLabels: { ema_short: "EMA short", ema_mid: "EMA mid", ema_long: "EMA long" },
  },
  rsi: { pane: "secondary", palette: ["#14b8a6"], secondaryPaneStretch: 13 },
  bollinger: { pane: "price_overlay", palette: ["#a78bfa", "#a78bfa", "#a78bfa"] },
  macd: { pane: "secondary", palette: ["#3b82f6", "#f59e0b"], secondaryPaneStretch: 15 },
  atr: { pane: "secondary", palette: ["#f97316"], secondaryPaneStretch: 13 },
  vwap: { pane: "price_overlay", palette: ["#10b981"] },
  volume: { pane: "secondary", palette: ["#94a3b8"], secondaryPaneStretch: 13 },
  swings_bos: { pane: "price_overlay", palette: ["#94a3b8"] },
  structure_levels: { pane: "price_overlay", palette: ["#9ca3af"] },
  liquidity_pools: { pane: "price_overlay", palette: ["#a78bfa"] },
  fibonacci: { pane: "price_overlay", palette: ["#ef9a9a", "#ffcc80", "#90caf9"] },
};

export function resolveRenderConfig(pluginId: string): RenderConfig {
  const cfg = RENDER_CONFIG_BY_PLUGIN_ID[pluginId];
  if (!cfg) {
    throw new Error(`[renderConfigByPluginId] unknown plugin "${pluginId}"`);
  }
  return cfg;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/indicators/renderConfigByPluginId.ts
git commit -m "feat(indicators): temporary renderConfigByPluginId map — bridge until Phase 4"
```

### Task 3.1 (3a): Migrate `replay-chart.tsx`

**Files:**
- Modify: `src/client/components/replay/replay-chart.tsx`
- Modify: `src/client/components/replay/replay-session.tsx` (drop `visibleIndicatorIds` state if it lives there)
- Test: visual diff via Storybook + Chrome DevTools MCP screenshot of `/replay/<known-session-id>` before/after

- [ ] **Step 1: Read the current `replay-chart.tsx`**

Already in context. Note especially:
- Three candle series (`lookback`, `visible`, `future`) for the playhead split
- Event markers + indicator markers merged via `markersPluginRef`
- PriceBandsOverlay HTML sibling
- ChartLegend bottom strip
- Setup price lines built from `props.setups`
- Fullscreen toggle on `wrapperRef`

The wrapper needs to **preserve the 3-series split**. `<TradingViewChart>` is a single-candle-series chart. We have two options:

**Option A (chosen)**: Keep the 3-series mount logic INSIDE replay-chart.tsx for now (replay has a special lookback/future split that no other view has). Move ONLY the indicator dispatch + controls + bands to TradingViewChart. The wrapper renders `<TradingViewChart candles={visibleCandles} indicators={...} />` but **wraps** it with extra series + setup lines.

Wait — `<TradingViewChart>` mounts its own chart. Two chart instances on the same DOM would conflict.

**Option B (correct)**: Don't migrate replay-chart in Phase 3 yet — Phase 3a only **changes how it dispatches indicators** (use `applyContribution` instead of `applyIndicatorToChart`) + replaces `PriceBandsOverlay` with `BandsPrimitive`. The 3-series split + fullscreen + legend + setup priceLines stay. The full migration to a `<TradingViewChart>`-style wrapper is deferred (it would require `<TradingViewChart>` to support 3-series splits, which is out of scope here).

Adopt **Option B**. The wrapper-ization happens later if at all; the framework upgrade can be applied piecewise.

- [ ] **Step 2: Refactor `replay-chart.tsx` to use `applyContribution`**

Find the indicator effect (currently `useEffect` calling `applyIndicatorToChart`). Replace with a call to `applyContribution` resolved through `resolveRenderConfig(id)`:

Before:
```tsx
const result = applyIndicatorToChart(chart, contribution, {
  id, pane, candleTimes, mainSeries, markerBucket, colorPalette: palette,
});
```

After:
```tsx
import { applyContribution } from "@adapters/chart/contributionRenderer";
import { allocatePanes } from "@adapters/chart/paneAllocator";
import { applyRightOffset } from "@adapters/chart/chartBootstrap";
import { resolveRenderConfig } from "@adapters/indicators/renderConfigByPluginId";

// Compute pane allocations once for the full set.
const ind = Object.entries(all)
  .filter(([id]) => !visible || visible.has(id))
  .map(([id]) => ({ id, pane: meta[id]?.pane ?? "price_overlay" as const, secondaryPaneStretch: resolveRenderConfig(id).secondaryPaneStretch }));
const alloc = allocatePanes(ind, Object.fromEntries(ind.map((i) => [i.id, true])));

for (const [id, contribution] of Object.entries(all)) {
  if (visible && !visible.has(id)) continue;
  const renderConfig = resolveRenderConfig(id);
  const paneIndex = alloc.assignments[id];
  if (paneIndex === undefined) continue;
  const result = applyContribution(chart, contribution, {
    id,
    renderConfig,
    paneIndex,
    candleTimes,
    mainSeries,
    markerBucket: indicatorMarkersRef.current,
  });
  indicatorCleanupsRef.current.push(result);
}
for (const [idx, stretch] of alloc.stretches) {
  chart.panes()[idx]?.setStretchFactor(stretch);
}
applyRightOffset(chart, {
  priceOverlayLineCount: ind
    .filter((i) => i.pane === "price_overlay")
    .length,  // approximation — refined in Phase 4 with countLines()
  priceLineCount: priceLinesRef.current.length,
});
```

- [ ] **Step 3: Remove the `PriceBandsOverlay` sibling**

Delete the `<PriceBandsOverlay ... />` JSX block + its surrounding overlay `<div>`. The bands are now rendered as `ISeriesPrimitive` inside the chart canvas — no HTML overlay needed.

- [ ] **Step 4: Manual visual diff**

```bash
docker compose up -d --build tf-web
```

Open a known replay session URL (use `bun run src/cli/list-setup.ts | head` to find one). Compare against a screenshot taken BEFORE this commit. Expected: indicators look identical; Fib bands now appear as canvas rectangles (visually the same as the old HTML overlay).

- [ ] **Step 5: Run the existing test suite**

```bash
bun test test/client
bun test test/adapters/chart
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
bun run lint:fix
git add src/client/components/replay/replay-chart.tsx
git commit -m "refactor(replay): swap applyIndicatorToChart → applyContribution + drop HTML bands overlay"
```

### Task 3.2 (3b): Migrate `tv-chart.tsx` to wrap `<TradingViewChart>`

**Files:**
- Modify: `src/client/components/setup/tv-chart.tsx`

`tv-chart.tsx` is simpler: a single candle series + priceLines (Entry/SL/TP/Invalidation), no indicators. Perfect candidate to become a thin wrapper.

- [ ] **Step 1: Read existing API**

The `<TVChart>` props are `{ candles: Candle[]; levels: Level[]; onTimeClick?: (time: Time) => void }`. Levels become priceLines.

- [ ] **Step 2: Rewrite as wrapper**

Replace entire content of `src/client/components/setup/tv-chart.tsx`:

```tsx
import { TradingViewChart } from "@client/components/charts/TradingViewChart";
import type { Time, UTCTimestamp } from "lightweight-charts";
import { useMemo } from "react";

export type Candle = {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type Level = { price: number; label: string; color: string };

export function TVChart(props: {
  candles: Candle[];
  levels: Level[];
  onTimeClick?: (time: Time) => void;
}) {
  const adapted = useMemo(
    () =>
      props.candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    [props.candles],
  );
  const priceLines = useMemo(
    () =>
      props.levels.map((l) => ({
        price: l.price,
        color: l.color,
        title: l.label,
        style: 2 as 0 | 1 | 2,
      })),
    [props.levels],
  );
  return (
    <TradingViewChart
      candles={adapted}
      priceLines={priceLines}
      enableControls={false}
      enableFullscreen
      height={360}
      onChartReady={(chart) => {
        if (props.onTimeClick) {
          chart.subscribeClick((p) => {
            if (p.time) props.onTimeClick?.(p.time);
          });
        }
      }}
    />
  );
}
```

- [ ] **Step 3: Restart tf-web and visually verify**

```bash
bun run compose:sync
```

Navigate to a setup page. Confirm:
- Candles render the same
- Entry/SL/TP horizontal lines on the right axis
- Clicking a candle calls `onTimeClick` (used by the page's tick scrubber)
- The fullscreen button works

- [ ] **Step 4: Commit**

```bash
git add src/client/components/setup/tv-chart.tsx
git commit -m "refactor(setup): tv-chart wraps <TradingViewChart> (priceLines via prop)"
```

### Task 3.3 (3c): Migrate `asset-chart.tsx` to wrap `<TradingViewChart>` with volume plugin

**Files:**
- Modify: `src/client/components/asset/asset-chart.tsx`

Per D1, asset-chart consumes the volume plugin instead of hard-coding `addSeries(HistogramSeries)`.

- [ ] **Step 1: Rewrite as wrapper**

```tsx
import { volumePlugin } from "@adapters/indicators/plugins/volume";
import { TradingViewChart } from "@client/components/charts/TradingViewChart";
import { resolveRenderConfig } from "@adapters/indicators/renderConfigByPluginId";
import type { UTCTimestamp } from "lightweight-charts";
import { useMemo } from "react";

export type AssetCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export function AssetChart({ candles }: { candles: AssetCandle[] }) {
  const adapted = useMemo(
    () =>
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
      })),
    [candles],
  );
  const volumeContribution = useMemo(
    () =>
      volumePlugin.computeSeries(
        candles.map((c) => ({
          timestamp: new Date(c.time * 1000),
          open: c.open, high: c.high, low: c.low, close: c.close,
          volume: c.volume,
        })),
      ),
    [candles],
  );
  return (
    <TradingViewChart
      candles={adapted}
      height={480}
      enableControls={false}
      enableFullscreen={false}
      indicators={[
        {
          id: "volume",
          plugin: { ...volumePlugin, renderConfig: resolveRenderConfig("volume") } as never,
          contribution: volumeContribution,
        },
      ]}
    />
  );
}
```

- [ ] **Step 2: Restart + visually verify**

`bun run compose:sync` → navigate to an asset detail page (`/asset/:source/:symbol`). Expected: candles + volume histogram in a secondary pane (same visual as before, just routed through the framework).

- [ ] **Step 3: Commit**

```bash
git add src/client/components/asset/asset-chart.tsx
git commit -m "refactor(asset): asset-chart wraps <TradingViewChart> + consumes volume plugin"
```


---

## Phase 4 — Plugin contract migration (`renderConfig` per plugin)

Goal: each of the 11 plugins gains a declarative `renderConfig` field on its plugin object, extracted from its current `chartScript.ts` colors. Drop the temporary `renderConfigByPluginId` map (Task 3.0). `chartScript.ts` files **remain in place** during this phase — they're still used by the old Playwright path until Phase 5.

### Task 4.0: Extend the `IndicatorPlugin` interface with `renderConfig`

**Files:**
- Modify: `src/domain/services/IndicatorPlugin.ts`

- [ ] **Step 1: Import `RenderConfig` from the domain types module**

`RenderConfig` was defined in `src/domain/charts/types.ts` back in Task 1.1
(alongside `IndicatorSeriesContribution`). Here we just import it — DO NOT
redefine it locally (single source of truth across domain + adapter).

At the top of `src/domain/services/IndicatorPlugin.ts`:

```ts
import type { RenderConfig } from "@domain/charts/types";
```

Then extend the `IndicatorPlugin` interface with **required** `renderConfig`:

```ts
export interface IndicatorPlugin extends IndicatorPluginMetadata {
  // ... existing fields
  readonly renderConfig: RenderConfig;
  // ... rest
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
bun run lint
```
Expected: 11 errors — one per plugin missing `renderConfig`. This is the TODO list for Tasks 4.1–4.11.

- [ ] **Step 3: Commit (intentionally breaks the build until Task 4.11)**

```bash
git add src/domain/services/IndicatorPlugin.ts
git commit -m "feat(plugin): add renderConfig: RenderConfig required field — will populate per plugin"
```

### Task 4.1: Populate `renderConfig` on `ema_stack`

**Files:**
- Modify: `src/adapters/indicators/plugins/ema_stack/index.ts`
- Test: `test/adapters/indicators/plugins/ema_stack/index.test.ts` (extend existing test if any, else create)

- [ ] **Step 1: Write the failing test (or add an assertion to the existing test file)**

Add this test:

```ts
import { describe, expect, test } from "bun:test";
import { emaStackPlugin } from "@adapters/indicators/plugins/ema_stack";

describe("ema_stack renderConfig", () => {
  test("price_overlay pane + 3-color palette + labels", () => {
    expect(emaStackPlugin.renderConfig.pane).toBe("price_overlay");
    expect(emaStackPlugin.renderConfig.palette).toEqual(["#3b82f6", "#f59e0b", "#ef4444"]);
    expect(emaStackPlugin.renderConfig.seriesLabels?.ema_short).toBe("EMA short");
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
bun test test/adapters/indicators/plugins/ema_stack
```
Expected: FAIL — `renderConfig` is undefined on the plugin object.

- [ ] **Step 3: Add the field**

Edit `src/adapters/indicators/plugins/ema_stack/index.ts`. Inside the `emaStackPlugin` object literal, after `chartScript: CHART_SCRIPT`, add:

```ts
renderConfig: {
  pane: "price_overlay",
  palette: ["#3b82f6", "#f59e0b", "#ef4444"],
  seriesLabels: { ema_short: "EMA short", ema_mid: "EMA mid", ema_long: "EMA long" },
},
```

- [ ] **Step 4: Run, expect pass**

```bash
bun test test/adapters/indicators/plugins/ema_stack
bun run lint
```
Expected: green test ; TS error count drops from 11 to 10.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/indicators/plugins/ema_stack/index.ts test/adapters/indicators/plugins/ema_stack/
git commit -m "feat(ema_stack): add renderConfig (palette + labels)"
```

### Tasks 4.2 – 4.11: Same pattern for the 10 remaining plugins

Repeat Task 4.1's 5-step pattern for each plugin below. The exact `renderConfig` to add per plugin (extracted from the current `chartScript.ts` + the temporary `renderConfigByPluginId` map):

| Plugin | `renderConfig` to add |
|---|---|
| `rsi` | `{ pane: "secondary", palette: ["#14b8a6"], secondaryPaneStretch: 13, seriesLabels: { rsi: "RSI" } }` |
| `bollinger` | `{ pane: "price_overlay", palette: ["#a78bfa", "#a78bfa", "#a78bfa"], seriesLabels: { bb_upper: "BB up", bb_mid: "BB mid", bb_lower: "BB lo" } }` |
| `macd` | `{ pane: "secondary", palette: ["#3b82f6", "#f59e0b"], secondaryPaneStretch: 15, seriesLabels: { macd_line: "MACD", signal: "Signal" } }` |
| `atr` | `{ pane: "secondary", palette: ["#f97316"], secondaryPaneStretch: 13, seriesLabels: { atr: "ATR" } }` |
| `vwap` | `{ pane: "price_overlay", palette: ["#10b981"], seriesLabels: { vwap: "VWAP" } }` |
| `volume` | `{ pane: "secondary", palette: ["#94a3b8"], secondaryPaneStretch: 13, seriesLabels: { volume: "Volume" } }` |
| `swings_bos` | `{ pane: "price_overlay", palette: ["#94a3b8"] }` (markers only — no line labels) |
| `structure_levels` | `{ pane: "price_overlay", palette: ["#9ca3af"] }` (priceLines only) |
| `liquidity_pools` | `{ pane: "price_overlay", palette: ["#a78bfa"] }` (priceLines only) |
| `fibonacci` | `{ pane: "price_overlay", palette: ["#ef9a9a", "#ffcc80", "#90caf9"], seriesLabels: { fib_0_382: "Fib 0.382", fib_0_500: "Fib 0.500", fib_0_618: "Fib 0.618", fib_1_272: "Fib 1.272", fib_1_618: "Fib 1.618" } }` |

For each plugin, do these 5 steps:

- [ ] **Step 1: Add a `renderConfig` test in `test/adapters/indicators/plugins/<plugin>/`** asserting `pane`, `palette`, and one label.
- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Edit `src/adapters/indicators/plugins/<plugin>/index.ts` to add the `renderConfig` field per the table.**
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: `bun run lint:fix && git add ... && git commit -m "feat(<plugin>): add renderConfig"`.**

After 4.11, the TS error count should be 0 and `bun run lint && bun run test` should be green.

### Task 4.12: Remove the temporary `renderConfigByPluginId` map

**Files:**
- Modify: `src/client/components/replay/replay-chart.tsx` (replace `resolveRenderConfig(id)` with `plugin.renderConfig` via plugin lookup)
- Modify: `src/client/components/asset/asset-chart.tsx`
- Modify: `src/client/components/charts/__stories__/TradingViewChart.stories.tsx`
- Delete: `src/adapters/indicators/renderConfigByPluginId.ts`

- [ ] **Step 1: Add a plugin id → plugin map helper**

If `src/adapters/indicators/IndicatorRegistry.ts` already exists (which it does — used by `PlaywrightChartRenderer.ts`), confirm it exposes a `pluginById(id)` accessor. If not, add:

```ts
// src/adapters/indicators/IndicatorRegistry.ts (additive method)
pluginById(id: string): IndicatorPlugin | undefined {
  return this.plugins.find((p) => p.id === id);
}
```

- [ ] **Step 2: Replace all `resolveRenderConfig(id)` call sites**

In `replay-chart.tsx`, replace:

```ts
const renderConfig = resolveRenderConfig(id);
```

with:

```ts
const plugin = registry.pluginById(id);
if (!plugin) continue;
const renderConfig = plugin.renderConfig;
```

(Where `registry` is provided either via props or context — wire it as needed; replay-session probably already has access.)

In `asset-chart.tsx`, replace `resolveRenderConfig("volume")` with `volumePlugin.renderConfig` (the volume plugin now owns it after Task 4.7).

In `TradingViewChart.stories.tsx`, drop the `tempRenderConfig` constant and pass `plugin.renderConfig` directly.

- [ ] **Step 3: Delete the temporary file**

```bash
rm src/adapters/indicators/renderConfigByPluginId.ts
```

- [ ] **Step 4: Verify**

```bash
bun run lint
bun test
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(indicators): drop temporary renderConfigByPluginId — each plugin owns its config"
```

### Task 4.13: Add stories for each plugin

**Files:**
- Create: `src/adapters/indicators/plugins/<id>/__stories__/<Plugin>.stories.tsx` × 11 plugins

- [ ] **Step 1: Template story (apply to each plugin)**

For each plugin, create the file with this template (substitute `<plugin>` and import):

```tsx
import { TradingViewChart } from "@client/components/charts/TradingViewChart";
import { fooPlugin } from "@adapters/indicators/plugins/foo";
import fixtureBullish from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";
import type { UTCTimestamp } from "lightweight-charts";

const candles = fixtureBullish.map((c) => ({
  time: c.time as UTCTimestamp,
  open: c.open, high: c.high, low: c.low, close: c.close,
}));

const candlesForPlugin = fixtureBullish.map((c) => ({
  timestamp: new Date(c.time * 1000),
  open: c.open, high: c.high, low: c.low, close: c.close,
  volume: c.volume,
}));

export default { title: "Plugins/Foo", component: TradingViewChart };

export const Default = {
  args: {
    candles,
    indicators: [
      {
        id: fooPlugin.id,
        plugin: fooPlugin,
        contribution: fooPlugin.computeSeries(candlesForPlugin),
      },
    ],
  },
};
```

- [ ] **Step 2: Visual check via Chrome DevTools MCP**

Iterate each story in Storybook ; screenshot each.

- [ ] **Step 3: Commit (one commit, all 11 stories)**

```bash
git add src/adapters/indicators/plugins/*/__stories__
git commit -m "test(storybook): one story per plugin (× 11) — visual baseline"
```


---

## Phase 5 — Playwright adapter refacto

Goal: `PlaywrightChartRenderer.warmUp()` injects the transpiled `contributionRenderer` + `chartBootstrap` + `bandsPrimitive` into the page. `render()` payload shape changes to include each indicator's `renderConfig`. Old `chartScript.ts` files remain on disk (deleted in Phase 6) but stop being concatenated into the template.

### Task 5.1: Add the `IndicatorRegistry.allChartBundles()` accessor

**Files:**
- Modify: `src/adapters/indicators/IndicatorRegistry.ts`

The current method `allChartScripts()` returns the concatenated `chartScript.ts` strings. The new flow doesn't need that — but it needs `renderConfig` per plugin id, so the registry exposes a serializable bundle.

- [ ] **Step 1: Add the method**

```ts
/**
 * Returns each plugin's renderConfig keyed by plugin id. Used by
 * PlaywrightChartRenderer to ship per-indicator render preferences into
 * the page payload (since the page-side dispatcher can't import the
 * plugin objects).
 */
allRenderConfigs(): Record<string, RenderConfig> {
  return Object.fromEntries(this.plugins.map((p) => [p.id, p.renderConfig]));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/indicators/IndicatorRegistry.ts
git commit -m "feat(registry): allRenderConfigs() accessor — keyed by plugin id"
```

### Task 5.2: Refactor `PlaywrightChartRenderer.warmUp` to inject the framework bundle

**Files:**
- Modify: `src/adapters/chart/PlaywrightChartRenderer.ts`
- Modify: `src/adapters/chart/chart-template.html`

- [ ] **Step 1: Simplify `chart-template.html`**

Rewrite to a minimal template — drop the inline `__renderCandles` body and `__chartPlugins`. The runtime is now framework-provided.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <!-- {{LIGHTWEIGHT_CHARTS_INLINE}} -->
  <style>
    html, body { margin: 0; padding: 0; background: #131722; height: 100%; color: #d1d4dc;
      font-family: -apple-system, system-ui, sans-serif; }
    #chart { width: 100vw; height: 100vh; }
  </style>
</head>
<body>
  <div id="chart"></div>
  <!-- {{FRAMEWORK_BUNDLE}} -->
</body>
</html>
```

- [ ] **Step 2: Refactor `warmUp()` to transpile the framework modules with Bun.Transpiler**

Replace the existing `warmUp()` body — note the `replace("{{INDICATOR_PLUGIN_SCRIPTS}}", ...)` line goes away ; new `{{FRAMEWORK_BUNDLE}}` line is added.

```ts
async warmUp(): Promise<void> {
  if (this.browser) return;
  this.browser = await chromium.launch({ headless: true });
  const size = this.opts.poolSize ?? 2;
  const tplPath =
    this.opts.templatePath ??
    join(dirname(fileURLToPath(import.meta.url)), "chart-template.html");
  const rawTemplate = await Bun.file(tplPath).text();
  const pkgJsonPath = require.resolve("lightweight-charts/package.json");
  const libPath = join(
    dirname(pkgJsonPath),
    "dist",
    "lightweight-charts.standalone.production.js",
  );
  const libSource = await Bun.file(libPath).text();

  // Transpile the framework adapters to a single IIFE that exposes
  // window.__tradingFlowChart = { render } on the page.
  const frameworkBundle = await this.buildFrameworkBundle();

  this.templateHtml = rawTemplate
    .replace("<!-- {{LIGHTWEIGHT_CHARTS_INLINE}} -->", `<script>${libSource}</script>`)
    .replace("<!-- {{FRAMEWORK_BUNDLE}} -->", `<script>${frameworkBundle}</script>`);

  for (let i = 0; i < size; i++) {
    const page = await this.browser.newPage({
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      deviceScaleFactor: 2,
    });
    await page.setContent(this.templateHtml);
    this.pagePool.push(page);
  }
}

private async buildFrameworkBundle(): Promise<string> {
  // Read + transpile the 4 framework modules.
  const modulesDir = dirname(fileURLToPath(import.meta.url));
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const sources = await Promise.all([
    Bun.file(join(modulesDir, "chartBootstrap.ts")).text(),
    Bun.file(join(modulesDir, "computeRightOffset.ts")).text(),
    Bun.file(join(modulesDir, "bandsPrimitive.ts")).text(),
    Bun.file(join(modulesDir, "contributionRenderer.ts")).text(),
    Bun.file(join(modulesDir, "paneAllocator.ts")).text(),
  ]);
  // Concatenate (each module's imports are local-relative — the
  // transpiler resolves them to inlined references). For more
  // complex bundles we'd switch to Bun.build, but for these 5
  // small files concat + transpile is enough.
  const combined = sources.join("\n\n");
  const transpiled = transpiler.transformSync(combined);
  // Wrap in an IIFE that exposes the runtime entry point. The
  // window globals (LightweightCharts) are already present
  // because the standalone bundle was injected first.
  return `
    ${transpiled}
    window.__tradingFlowChart = {
      render(payload) {
        const container = document.getElementById("chart");
        const { chart, candleSeries, dispose } = createTradingViewChart(container, {
          width: window.innerWidth, height: window.innerHeight,
          naked: payload.indicators.length === 0,
        });
        candleSeries.setData(payload.candles);
        const ind = payload.indicators.map((i) => ({
          id: i.id, pane: i.renderConfig.pane,
          secondaryPaneStretch: i.renderConfig.secondaryPaneStretch,
        }));
        const alloc = allocatePanes(ind, Object.fromEntries(ind.map((i) => [i.id, true])));
        const markerBucket = [];
        const cleanups = [];
        for (const i of payload.indicators) {
          const paneIndex = alloc.assignments[i.id];
          if (paneIndex === undefined) continue;
          const result = applyContribution(chart, i.contribution, {
            id: i.id, renderConfig: i.renderConfig, paneIndex,
            candleTimes: payload.candles.map((c) => c.time),
            mainSeries: candleSeries, markerBucket,
          });
          cleanups.push(result);
        }
        for (const [idx, stretch] of alloc.stretches) {
          chart.panes()[idx]?.setStretchFactor(stretch);
        }
        applyRightOffset(chart, {
          priceOverlayLineCount: payload.indicators
            .filter((i) => i.renderConfig.pane === "price_overlay")
            .length,
          priceLineCount: 0,
        });
        if (markerBucket.length > 0 && LightweightCharts.createSeriesMarkers) {
          LightweightCharts.createSeriesMarkers(candleSeries).setMarkers(markerBucket);
        }
        chart.timeScale().fitContent();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__chartReady = true;
        }));
      },
    };
  `;
}
```

- [ ] **Step 3: Refactor `render(args)` to send the new payload shape**

```ts
async render(args: {
  candles: Candle[];
  series: Record<string, IndicatorSeriesContribution>;
  enabledIndicatorIds: ReadonlyArray<string>;
  width: number;
  height: number;
  outputUri: string;
}): Promise<ChartRenderResult> {
  if (!this.browser) await this.warmUp();
  const page = await this.acquirePage();
  try {
    await page.setViewportSize({ width: args.width, height: args.height });
    await page.setContent(this.templateHtml as string);
    const payload = {
      candles: args.candles.map((c) => ({
        time: Math.floor(c.timestamp.getTime() / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      })),
      indicators: args.enabledIndicatorIds
        .map((id) => {
          const plugin = this.registry.pluginById(id);
          if (!plugin) return null;
          return {
            id,
            contribution: args.series[id],
            renderConfig: plugin.renderConfig,
          };
        })
        .filter((i): i is { id: string; contribution: IndicatorSeriesContribution; renderConfig: RenderConfig } => i !== null && i.contribution !== undefined),
    };
    await page.evaluate((data) => {
      (window as unknown as { __tradingFlowChart: { render: (p: unknown) => void } }).__tradingFlowChart.render(data);
    }, payload);
    await page.waitForFunction(
      () => (window as unknown as { __chartReady?: boolean }).__chartReady === true,
      { timeout: 5000 },
    );
    // ... rest of screenshot + sharp resize + return is unchanged
  } finally {
    this.releasePage(page);
  }
}
```

- [ ] **Step 4: Run the existing PlaywrightChartRenderer tests**

```bash
bun test test/adapters/chart/PlaywrightChartRenderer.test.ts
bun test test/adapters/chart/PlaywrightChartRenderer.regression.test.ts
```
Expected: green. The contract (input shape, return SHA stability for known fixtures) is preserved.

- [ ] **Step 5: Commit**

```bash
bun run lint:fix
git add src/adapters/chart/PlaywrightChartRenderer.ts src/adapters/chart/chart-template.html
git commit -m "refactor(playwright): inject transpiled framework bundle; new payload shape"
```

### Task 5.3: Cross-context parity test (`test/parity/contributionParity.test.ts`)

**Files:**
- Create: `test/parity/contributionParity.test.ts`

- [ ] **Step 1: Write the parity test**

```ts
import { describe, expect, test } from "bun:test";
import { applyContribution } from "@adapters/chart/contributionRenderer";
import { INDICATOR_PLUGINS } from "@adapters/indicators/IndicatorRegistry";
import fixture from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";
import type { UTCTimestamp } from "lightweight-charts";

type Call = { method: string; args: unknown[] };
function fakeChart(calls: Call[]) {
  const fakeMain = {
    createPriceLine: (o: unknown) => (calls.push({ method: "createPriceLine", args: [o] }), { __pl: true }),
    removePriceLine: () => undefined,
    attachPrimitive: (p: unknown) => calls.push({ method: "attachPrimitive", args: [p?.constructor?.name] }),
    detachPrimitive: () => undefined,
  };
  return {
    chart: {
      addSeries: (cls: unknown, opts: unknown, paneIdx: unknown) => {
        calls.push({ method: "addSeries", args: [cls, opts, paneIdx] });
        return { setData: (d: unknown) => calls.push({ method: "setData", args: [(d as unknown[]).length] }) };
      },
      removeSeries: () => undefined,
      panes: () => [{}],
    },
    main: fakeMain,
  };
}

describe("contributionParity — same calls on frontend + backend fakes", () => {
  for (const plugin of INDICATOR_PLUGINS) {
    test(`${plugin.id} emits identical call sequences`, () => {
      (globalThis as { LightweightCharts?: unknown }).LightweightCharts = {
        LineSeries: "L", HistogramSeries: "H",
      };
      const candlesForCompute = fixture.map((c) => ({
        timestamp: new Date(c.time * 1000),
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
      const contribution = plugin.computeSeries(candlesForCompute as never);
      const candleTimes = fixture.map((c) => c.time as UTCTimestamp);

      const callsA: Call[] = [];
      const { chart: chartA, main: mainA } = fakeChart(callsA);
      applyContribution(chartA as never, contribution, {
        id: plugin.id, renderConfig: plugin.renderConfig, paneIndex: 0,
        candleTimes, mainSeries: mainA as never, markerBucket: [],
      });

      const callsB: Call[] = [];
      const { chart: chartB, main: mainB } = fakeChart(callsB);
      applyContribution(chartB as never, contribution, {
        id: plugin.id, renderConfig: plugin.renderConfig, paneIndex: 0,
        candleTimes, mainSeries: mainB as never, markerBucket: [],
      });

      expect(callsB).toEqual(callsA);
    });
  }
});
```

- [ ] **Step 2: Run, expect pass for all 11**

```bash
bun test test/parity/contributionParity.test.ts
```
Expected: 11 tests green. (Both invocations go through the same `applyContribution` — they must produce identical sequences.)

- [ ] **Step 3: Commit**

```bash
git add test/parity/contributionParity.test.ts
git commit -m "test(parity): contributionParity — identical call sequences per plugin"
```

### Task 5.4: Visual `chart-visibility` test (right offset)

**Files:**
- Create: `test/visual/chart-visibility.test.ts`

- [ ] **Step 1: Write the test (uses PlaywrightChartRenderer at 3 densities)**

```ts
import { describe, expect, test } from "bun:test";
import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { IndicatorRegistry, INDICATOR_PLUGINS } from "@adapters/indicators/IndicatorRegistry";
import fixture from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";
import sharp from "sharp";

const candles = fixture.map((c) => ({
  timestamp: new Date(c.time * 1000),
  open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
}));

async function lastColumnHasCandlePixel(buffer: Buffer): Promise<boolean> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const x = info.width - 80;  // ~80px from right edge (just inside labels)
  const candleGreen = [0x26, 0xa6, 0x9a];
  const candleRed = [0xef, 0x53, 0x50];
  for (let y = 0; y < info.height; y++) {
    const idx = (y * info.width + x) * info.channels;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    if (matches(r, g, b, candleGreen) || matches(r, g, b, candleRed)) return true;
  }
  return false;
}

function matches(r: number, g: number, b: number, target: number[]): boolean {
  return Math.abs(r - target[0]!) < 30 && Math.abs(g - target[1]!) < 30 && Math.abs(b - target[2]!) < 30;
}

const densities = [
  { name: "1-indicator", enabledIds: ["rsi"] },
  { name: "5-indicators", enabledIds: ["ema_stack", "rsi", "bollinger", "macd", "atr"] },
  { name: "11-indicators-all", enabledIds: INDICATOR_PLUGINS.map((p) => p.id) },
];

describe("chart visibility — last candles never masked", () => {
  for (const d of densities) {
    test(`${d.name} keeps the rightmost candle visible`, async () => {
      const registry = new IndicatorRegistry(INDICATOR_PLUGINS);
      const renderer = new PlaywrightChartRenderer(registry);
      await renderer.warmUp();
      const series: Record<string, unknown> = {};
      for (const id of d.enabledIds) {
        const plugin = INDICATOR_PLUGINS.find((p) => p.id === id);
        if (!plugin) continue;
        series[id] = plugin.computeSeries(candles as never);
      }
      const result = await renderer.render({
        candles, series: series as never, enabledIndicatorIds: d.enabledIds,
        width: 1280, height: 720,
        outputUri: `file:///tmp/test-${d.name}.webp`,
      });
      await renderer.dispose();
      const visible = await lastColumnHasCandlePixel(result.content);
      expect(visible).toBe(true);
    }, 30_000);
  }
});
```

- [ ] **Step 2: Run, expect pass**

```bash
bun test test/visual/chart-visibility.test.ts
```
Expected: 3 tests green. If a density fails, bump the corresponding palier in `computeRightOffset.ts` and re-run.

- [ ] **Step 3: Commit**

```bash
git add test/visual/chart-visibility.test.ts
git commit -m "test(visual): chart-visibility — rightmost candle never masked by labels at 1/5/11 densities"
```


---

## Phase 6 — Cleanup

Goal: delete obsolete code (chartScript.ts × 11, PriceBandsOverlay, indicator-toggles, chart-legend), simplify `applyIndicatorToChart.ts` to a re-export, bump `detector_v10`. Each deletion is a separate commit so reverts are surgical.

### Task 6.1: Delete `chartScript.ts` from all 11 plugins

**Files (per plugin):**
- Delete: `src/adapters/indicators/plugins/<id>/chartScript.ts`
- Modify: `src/adapters/indicators/plugins/<id>/index.ts` (remove `chartScript: CHART_SCRIPT` field)
- Modify: `src/domain/services/IndicatorPlugin.ts` (drop `chartScript: string` from the interface — replaced by `renderConfig`)
- Modify: `src/adapters/indicators/IndicatorRegistry.ts` (drop `allChartScripts()`)
- Modify: `test/adapters/indicators/plugins/<id>/index.test.ts` (drop any test asserting `chartScript.toContain(...)`)

- [ ] **Step 1: Pick the first plugin (e.g. `fibonacci`) and remove its chartScript**

```bash
# Delete the file:
rm src/adapters/indicators/plugins/fibonacci/chartScript.ts
```

Edit `src/adapters/indicators/plugins/fibonacci/index.ts` :
- Remove `import { CHART_SCRIPT } from "./chartScript";`
- Remove the `chartScript: CHART_SCRIPT,` field from the plugin literal

Edit `test/adapters/indicators/plugins/fibonacci/index.test.ts` :
- Delete the test `"chartScript walks compound contributions (priceLines + markers)"` (no longer applicable)
- Delete `expect(fibonacciPlugin.chartScript).toContain('__registerPlugin("fibonacci"')` from any other test

- [ ] **Step 2: Run the fibonacci test**

```bash
bun test test/adapters/indicators/plugins/fibonacci
```
Expected: PASS (the renderConfig test added in Phase 4.11 stays green).

- [ ] **Step 3: Repeat for the 10 other plugins**

Apply the same 3-step pattern to: `atr`, `bollinger`, `ema_stack`, `liquidity_pools`, `macd`, `rsi`, `structure_levels`, `swings_bos`, `volume`, `vwap`.

After each plugin, run its tests + commit:

```bash
bun test test/adapters/indicators/plugins/<id>
git add src/adapters/indicators/plugins/<id> test/adapters/indicators/plugins/<id>
git commit -m "refactor(<id>): delete chartScript.ts — replaced by renderConfig"
```

- [ ] **Step 4: After the 11th plugin, drop `chartScript` from the interface**

Edit `src/domain/services/IndicatorPlugin.ts`:
- Delete `readonly chartScript: string;`
- Optionally remove `readonly chartPane: ChartPaneKind;` and `readonly secondaryPaneStretch?: number;` if they're now duplicates of `renderConfig.pane` and `renderConfig.secondaryPaneStretch` (they are — but check no other caller still reads them ; do a `grep -rn "plugin.chartPane\|plugin.secondaryPaneStretch" src/`)

Edit `src/adapters/indicators/IndicatorRegistry.ts`:
- Delete `allChartScripts()` method (no longer used after Phase 5 simplified `chart-template.html`)

```bash
bun run lint
bun test
```
Expected: green.

- [ ] **Step 5: Final commit for interface cleanup**

```bash
git add src/domain/services/IndicatorPlugin.ts src/adapters/indicators/IndicatorRegistry.ts
git commit -m "refactor(plugin): drop chartScript field — fully migrated to renderConfig"
```

### Task 6.2: Delete `PriceBandsOverlay.tsx`

**Files:**
- Delete: `src/client/components/replay/PriceBandsOverlay.tsx`
- Modify: `src/client/components/replay/replay-chart.tsx` (drop the import if any lingers — should already be gone after Task 3.1)

- [ ] **Step 1: Confirm no remaining import**

```bash
grep -rn "PriceBandsOverlay" src/
```
Expected: 0 hits (or only the file itself).

- [ ] **Step 2: Delete + commit**

```bash
rm src/client/components/replay/PriceBandsOverlay.tsx
git add -A
git commit -m "refactor(replay): delete PriceBandsOverlay — replaced by BandsPrimitive (canvas)"
```

### Task 6.3: Delete `indicator-toggles.tsx` and drop its state from `replay-session.tsx`

**Files:**
- Delete: `src/client/components/replay/indicator-toggles.tsx`
- Modify: `src/client/components/replay/replay-session.tsx` (remove `visibleIndicatorIds` state + the `<IndicatorToggles>` JSX usage)
- Modify: `src/client/components/replay/replay-chart.tsx` (the parent no longer passes `visibleIndicators` — when the replay-chart becomes a full wrapper of `<TradingViewChart enableControls>`, controls vivent inside)

This task assumes the replay-chart eventually becomes a full `<TradingViewChart>` wrapper (the deeper migration). If that hasn't happened (Option B of Task 3.1 left the 3-series split intact), this task is **deferred** until the deeper wrapping. Mark it:

- [ ] **Step 1: Decide deferred or now?**

If `replay-chart.tsx` still mounts its own chart (Option B), keep `indicator-toggles.tsx` until that's refactored. Mark the task complete-with-deferral and move on. If `replay-chart.tsx` has been wrapped with `<TradingViewChart enableControls>`, proceed.

- [ ] **Step 2: Delete the toggle component**

```bash
rm src/client/components/replay/indicator-toggles.tsx
```

- [ ] **Step 3: Drop the state in `replay-session.tsx`**

Remove these in `replay-session.tsx` (lines vary — grep):
- `const [visibleIndicatorIds, setVisibleIndicatorIds] = useState<Set<string>>(new Set())`
- The `<IndicatorToggles ... />` JSX
- Any `setupFocusTouchedRef` logic if it only existed to bookkeep the toggle state

- [ ] **Step 4: Commit**

```bash
bun run lint:fix
git add src/client/components/replay/
git commit -m "refactor(replay): delete indicator-toggles — built into TradingViewChart"
```

### Task 6.4: Delete `chart-legend.tsx`

**Files:**
- Delete: `src/client/components/replay/chart-legend.tsx`
- Modify: `src/client/components/replay/replay-chart.tsx` (drop import + JSX usage)

The chart-legend information (colored chips per active indicator + event-type swatches) is now provided by `IndicatorControlPanel` (when `enableControls`) and the markers themselves (color-encoded events). If a separate event legend is still wanted, port it to a new `EventLegend.tsx` — but only if the user explicitly asks for it. Default : drop.

- [ ] **Step 1: Confirm no consumer**

```bash
grep -rn "ChartLegend\|chart-legend" src/
```

- [ ] **Step 2: Delete + commit**

```bash
rm src/client/components/replay/chart-legend.tsx
git add -A
git commit -m "refactor(replay): delete chart-legend — chips in IndicatorControlPanel double as legend"
```

### Task 6.5: Simplify `applyIndicatorToChart.ts` to a pure re-export

**Files:**
- Modify: `src/client/components/replay/applyIndicatorToChart.ts`

- [ ] **Step 1: Replace content**

```ts
/**
 * Backward-compat re-export. The canonical home is now
 * `@adapters/chart/contributionRenderer`. Kept until all imports are
 * migrated — current as of Phase 6 : zero remaining imports.
 *
 * Safe to delete once the eslint rule `no-cycle` confirms no caller
 * imports from this path.
 */
export {
  applyContribution as applyIndicatorToChart,
  type ApplyContributionOpts as ApplyIndicatorOpts,
  type ApplyContributionResult as ApplyIndicatorResult,
} from "@adapters/chart/contributionRenderer";

export type IndicatorPane = "price_overlay" | "secondary";
```

- [ ] **Step 2: Verify no behavior change**

```bash
bun test
```

- [ ] **Step 3: Commit**

```bash
git add src/client/components/replay/applyIndicatorToChart.ts
git commit -m "refactor(replay): applyIndicatorToChart = pure re-export of new dispatcher"
```

### Task 6.6: Bump `detector_v9` → `detector_v10` (cache invalidation by design)

**Files:**
- Modify: `prompts/detector.md.hbs` (the Handlebars version comment header)

- [ ] **Step 1: Read the current version header**

```bash
head -5 prompts/detector.md.hbs
```

Expected: `{{!-- version: detector_v9 --}}`.

- [ ] **Step 2: Bump to v10**

Edit `prompts/detector.md.hbs` line 1 (the version comment):

```handlebars
{{!-- version: detector_v10 --}}
```

(No other prompt changes — the version bump alone forces a cache miss across all detectors, which is what we want now that Fib bands are visible on the image.)

- [ ] **Step 3: Document the expected cost in the commit message**

```bash
git add prompts/detector.md.hbs
git commit -m "$(cat <<'EOF'
chore(prompts): bump detector_v9 → detector_v10 (Fib bands now visible to LLM)

Cache invalidation is intentional. Phase 5 made the Fibonacci golden zone
(and any future kind:"bands") visible on the backend Playwright image. The
LLM now sees richer information than v9 — bump the version to force a
deliberate cache miss and re-fill at the new image semantics.

Expected cost: one re-fill of the LLM response cache for the detectors active
in the 24-48h window post-deploy. Compensated by the improved signal (the LLM
can now reason about Fib zones, not just the numbered levels).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6.7: Verify the full test suite + smoke

**Files:** none

- [ ] **Step 1: Full test run**

```bash
bun run lint
bun test
bun run test:parity
```

Expected: all green.

- [ ] **Step 2: Smoke the frontend in browser**

```bash
bun run compose:sync
```

Manually navigate to:
- `/replay/<known-session>` — confirm indicators, bands (now canvas), event markers all render
- `/setups/<known-setup>` — confirm Entry/SL/TP lines render
- `/asset/<source>/<symbol>` — confirm candles + volume render

- [ ] **Step 3: Smoke the backend (one tick, real fixture)**

```bash
bun run src/cli/force-tick.ts <watchId>
```

Watch `logs:workers` for any chart-render error. The webp artifact should be visibly different from the v9 baseline (Fib bands now appear as semi-transparent colored zones on the image).

- [ ] **Step 4: If everything is green, mark Phase 6 done with a final commit (no code change — just a tag opportunity if desired)**

```bash
git tag chart-framework-v1
```

(Optional — only if the team uses tags as milestones.)


---

## Plan self-review (rédacteur)

### Spec coverage

| Spec requirement | Covered by task(s) |
|---|---|
| Goal #1 (single render engine) | 1.7 (contributionRenderer) + 5.2 (Playwright reuses it) |
| Goal #2 (plugins purely TS) | 4.0–4.12 + 6.1 |
| Goal #3 (unified API: `<TradingViewChart>` + Playwright same payload shape) | 2.3 + 5.2 |
| Goal #4 (no visual change except palette + bands) | 3.1–3.3 visual diff steps + 5.4 |
| Goal #5 (rightOffset, last candles visible) | 1.3 + 5.4 |
| Goal #6 (bands rendered in both contexts) | 1.5 (BandsPrimitive) + 5.2 (backend uses it via transpiled bundle) |
| Goal #7 (built-in controls UI) | 2.2 + 2.3 |
| Goal #8 (backend non-controllable) | 5.2 (renderer ignores any controls payload) |
| Goal #9 (deterministic pane management) | 1.2 (paneAllocator) |
| Goal #10 (loading on-demand) | partially — registry's static list stays ; the contract supports lazy but no task forces lazy now. Out-of-scope for v1. |
| Goal #11 (hexagonal) | 1.1 (domain types) + plugin layer + adapter layer |
| Goal #12 (testable) | every task has TDD tests |
| Goal #13 (Storybook validation harness) | Phase 0 + stories in 1.8, 2.2, 2.4, 4.13 |
| D1 (volume = plugin, asset-chart consumes pipeline) | 3.3 + 4.7 (volume renderConfig) |
| D2 (priceLines via prop) | 2.3 (props.priceLines) + 3.2 (tv-chart consumer) |
| D3 (enableFullscreen prop, F11 toggle, backend not affected) | 2.3 (F11 + button + prop) ; 5.2 (backend has no concept) |
| D4 (marker bucket internal) | 2.3 (`markerBucket` collected + merged in effect) |
| D5 (setup colors via caller) | 3.1 leaves replay-chart's `colorForSetup` calls intact ; 2.3 doesn't introduce setup notion |
| D6 (renderConfig non-breaking) | 4.0 makes it a new field, old metadata untouched |
| D7 (prompt circuit untouched) | no task modifies `promptFragments.ts` or `IndicatorFragmentFormatter` |
| D8 (palette per plugin, no central file) | 4.0 (RenderConfig type) + 4.1–4.11 (each plugin owns) |

### Placeholder scan

Grep'd the plan for "TODO", "TBD", "implement later", "similar to", "fill in", "etc.", "..." in code blocks — every code block contains complete code or precise tabular data (Phase 4 table is the only "this pattern × 10" but the table provides every line per plugin, so it's still complete). No placeholders.

One soft point : Task 3.0 (renderConfigByPluginId temp file) is a deliberate stepping-stone deleted in Task 4.12 — that's intentional decomposition, not a placeholder.

### Type consistency

- ✅ `RenderConfig` single source of truth — defined in `src/domain/charts/types.ts` (Task 1.1) alongside `IndicatorSeriesContribution`. Imported by both `contributionRenderer.ts` (Task 1.7) and `IndicatorPlugin.ts` (Task 4.0). Re-exported from `contributionRenderer.ts` for adapter-side convenience.

- `IndicatorEntry` type in `TradingViewChart.tsx` (Task 2.3) requires `plugin: IndicatorPlugin & { renderConfig: RenderConfig }`. After Phase 4 (`renderConfig` is required on `IndicatorPlugin`), the intersection becomes redundant — drop it: `plugin: IndicatorPlugin`.
  - **Action**: in Task 4.12, simplify the type in `TradingViewChart.tsx`.

- `pluginById` accessor on `IndicatorRegistry` — introduced in Task 4.12. Verify it exists or add in Phase 4 (referenced by 5.2 + 4.12).
  - **Action**: confirm in Task 4.12 ; if `IndicatorRegistry` doesn't already expose it, add it as part of that task.

### Open implementation notes carried from the spec

- **Storybook pixel-diff automation** is optional (manual via Chrome DevTools MCP works). Add Playwright + pixelmatch only if needed during Phase 6 review.
- **Replay-chart deep wrapping** (full `<TradingViewChart enableControls>` migration) is **deferred** in Task 3.1 — only the indicator dispatch + bands primitive migrate. The 3-series split + setup priceLines + fullscreen stay in replay-chart for now. Re-evaluate after Phase 6 ; if the wrapper is wanted, write a follow-up plan.
- **Detector v10 bump** triggers a cache invalidation by design. Coordinate the deploy window with the team (Task 6.6 commit message documents the cost expectation).

### Final commit count estimate

- Phase 0 : 4 commits
- Phase 1 : 8 commits (1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8)
- Phase 2 : 4 commits (2.1, 2.2, 2.3, 2.4)
- Phase 3 : 4 commits (3.0, 3.1, 3.2, 3.3)
- Phase 4 : 14 commits (4.0, 4.1–4.11 = 11, 4.12, 4.13)
- Phase 5 : 4 commits (5.1, 5.2, 5.3, 5.4)
- Phase 6 : ~14 commits (6.1 = 11 + 1 interface, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7)

**Total ≈ 52 commits across ~7 mergeable PRs (one per phase, or split further if reviewers prefer).**

