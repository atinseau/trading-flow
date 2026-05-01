# Indicators Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the indicators modularization shipped on 2026-04-30 by consolidating low-content plugins, implementing the dormant `featuredFewShotExample` slot, exposing per-plugin parameters in the wizard UI, and running an empirical validation comparing naked vs equipped watches.

**Architecture:** 4 phases applied to the existing `IndicatorPlugin` registry. Phase 1 reduces plugin count (12→10) by merging `fvg` + `poc` + `recent_range` into a single `structure_levels` plugin. Phase 2 fills the dead `featuredFewShotExample` slot for 4 high-signal plugins. Phase 3 extends the contract with `paramsSchema` + `defaultParams`, plumbs them through the calculator/inputHash/UI. Phase 4 is a manual runbook for A/B comparing naked vs equipped on a real asset.

**Tech Stack:** Bun, TypeScript, Zod v4, Drizzle, Handlebars, lightweight-charts, React + react-hook-form.

**Reference work:** `docs/superpowers/plans/2026-04-30-indicators-modularization.md` (parent plan, fully shipped on branch `feat/indicators-modularization` at commit `0da42c7`).

**Pre-conditions before executing this plan:**
- The parent branch `feat/indicators-modularization` is merged into `main`.
- The user runs `scripts/nuke-trading-flow.ts --yes` once at deploy time (kills all rows; the new schema requires it because `KNOWN_INDICATOR_IDS` shrinks from 12 to 10 in Phase 1, breaking any persisted matrix that referenced removed ids).

---

## File Structure

### Phase 1 — Consolidation

```
NEW:
  src/adapters/indicators/plugins/structure_levels/
    compute.ts                  # consolidated compute (recentH/L + POC + FVG bands)
    metadata.ts
    promptFragments.ts
    chartScript.ts
    index.ts

REMOVED:
  src/adapters/indicators/plugins/fvg/                  (whole folder)
  src/adapters/indicators/plugins/poc/                  (whole folder)
  src/adapters/indicators/plugins/recent_range/         (whole folder)
  test/adapters/indicators/plugins/{fvg,poc,recent_range}/  (whole folders)

MODIFIED:
  src/domain/schemas/WatchesConfig.ts                   # KNOWN_INDICATOR_IDS shrinks
  src/adapters/indicators/IndicatorRegistry.ts          # registry ordering
  src/shared/indicatorMetadata.ts                       # metadata aggregator
  src/client/lib/indicatorsPresets.ts                   # PRESETS.recommended
  src/workflows/scheduler/preFilter.ts                  # near_pivot now on structure_levels
```

### Phase 2 — Few-shot examples

```
MODIFIED:
  src/adapters/indicators/plugins/bollinger/promptFragments.ts        # add featuredFewShotExample
  src/adapters/indicators/plugins/bollinger/index.ts                  # wire it
  src/adapters/indicators/plugins/swings_bos/promptFragments.ts
  src/adapters/indicators/plugins/swings_bos/index.ts
  src/adapters/indicators/plugins/volume/promptFragments.ts
  src/adapters/indicators/plugins/volume/index.ts
  src/adapters/indicators/plugins/liquidity_pools/promptFragments.ts
  src/adapters/indicators/plugins/liquidity_pools/index.ts
```

### Phase 3 — Per-plugin parameters

```
MODIFIED:
  src/domain/services/IndicatorPlugin.ts                # contract extension
  src/domain/schemas/WatchesConfig.ts                   # IndicatorConfigSchema.params
  src/adapters/indicators/PureJsIndicatorCalculator.ts  # threads params to compute()
  src/domain/services/inputHash.ts                      # hashes params

  src/adapters/indicators/plugins/<id>/compute.ts       # for each plugin with params
  src/adapters/indicators/plugins/<id>/index.ts         # exports paramsSchema + defaultParams
  src/adapters/indicators/plugins/<id>/metadata.ts      # also exports defaultParams (client-safe)

NEW:
  src/client/components/watch-form/indicator-params-panel.tsx       # generic params form
  src/client/lib/indicatorParams.ts                                 # form helpers

MODIFIED:
  src/client/components/watch-form/section-indicators.tsx           # mount panel under checked indicators
  src/shared/indicatorMetadata.ts                                   # exposes defaultParams + paramsSchema (json-only)
```

### Phase 4 — Empirical validation runbook

```
NEW (documentation):
  docs/superpowers/runbooks/2026-05-01-naked-vs-equipped-validation.md
```

---

## Phase 1 — Consolidate `fvg` + `poc` + `recent_range` into `structure_levels`

### Task 1: Create `structure_levels` compute + metadata + prompt fragments

**Files:**
- Create: `src/adapters/indicators/plugins/structure_levels/compute.ts`
- Create: `src/adapters/indicators/plugins/structure_levels/metadata.ts`
- Create: `src/adapters/indicators/plugins/structure_levels/promptFragments.ts`
- Test: `test/adapters/indicators/plugins/structure_levels/index.test.ts` (new)

The new plugin owns the union of: `recentHigh` / `recentLow` / `pocPrice` / `fvgs[]` (the FVG bands as a series contribution).

- [ ] **Step 1: Write the failing test**

```ts
// test/adapters/indicators/plugins/structure_levels/index.test.ts
import { describe, expect, test } from "bun:test";
import { structureLevelsPlugin } from "@adapters/indicators/plugins/structure_levels";

const sampleCandles = Array.from({ length: 80 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 4, 1, i)),
  open: 100, high: 100 + Math.sin(i / 5),
  low: 99 - Math.sin(i / 5),
  close: 100 + Math.sin(i / 5) * 0.5, volume: 1000 + i,
}));

describe("structureLevelsPlugin", () => {
  test("metadata", () => {
    expect(structureLevelsPlugin.id).toBe("structure_levels");
    expect(structureLevelsPlugin.tag).toBe("structure");
    expect(structureLevelsPlugin.preFilterCriterion).toBe("near_pivot");
    expect(structureLevelsPlugin.breakdownAxes).toEqual(["structure"]);
  });

  test("computeScalars exposes recentHigh, recentLow, pocPrice", () => {
    const s = structureLevelsPlugin.computeScalars(sampleCandles);
    expect(typeof s.recentHigh).toBe("number");
    expect(typeof s.recentLow).toBe("number");
    expect(typeof s.pocPrice).toBe("number");
    expect(s.recentLow as number).toBeLessThan(s.recentHigh as number);
  });

  test("computeSeries returns priceLines (HH/LL + FVG bands)", () => {
    const series = structureLevelsPlugin.computeSeries(sampleCandles);
    expect(series.kind).toBe("priceLines");
    if (series.kind !== "priceLines") throw new Error();
    const titles = series.lines.map((l) => l.title);
    expect(titles).toContain("HH");
    expect(titles).toContain("LL");
  });

  test("detectorPromptFragment cites all 3 levels", () => {
    const txt = structureLevelsPlugin.detectorPromptFragment({
      recentHigh: 105.5, recentLow: 95.2, pocPrice: 100.1,
    });
    expect(txt).toContain("105.50");
    expect(txt).toContain("95.20");
    expect(txt).toContain("100.10");
  });
});
```

- [ ] **Step 2: Run test to verify FAIL**

```bash
cd /Users/arthur/Documents/Dev/projects/trading-flow
bun test test/adapters/indicators/plugins/structure_levels/
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `compute.ts`**

```ts
// src/adapters/indicators/plugins/structure_levels/compute.ts
import type { Candle } from "@domain/schemas/Candle";
import { detectFvgs, pointOfControl } from "../base/math";

const RECENT_WINDOW = 50;
const POC_BUCKETS = 30;
const FVG_TAIL = 10;

export function computeScalars(candles: Candle[]) {
  const tail = candles.slice(-RECENT_WINDOW);
  const recentHigh = Math.max(...tail.map((c) => c.high));
  const recentLow = Math.min(...tail.map((c) => c.low));
  const pocPrice = pointOfControl(tail, POC_BUCKETS);
  return { recentHigh, recentLow, pocPrice };
}

export function computePriceLines(candles: Candle[]) {
  const tail = candles.slice(-RECENT_WINDOW);
  const recentHigh = Math.max(...tail.map((c) => c.high));
  const recentLow = Math.min(...tail.map((c) => c.low));
  const fvgs = detectFvgs(candles).slice(-FVG_TAIL);
  const fvgLines = fvgs.flatMap((fvg) => {
    const color = fvg.direction === "bullish"
      ? "rgba(38,166,154,0.35)" : "rgba(239,83,80,0.35)";
    return [
      { price: fvg.top, color, style: 0 as const, title: "" },
      { price: fvg.bottom, color, style: 0 as const, title: "" },
    ];
  });
  return [
    { price: recentHigh, color: "#888", style: 2 as const, title: "HH" },
    { price: recentLow, color: "#888", style: 2 as const, title: "LL" },
    ...fvgLines,
  ];
}
```

- [ ] **Step 4: Create `metadata.ts`**

```ts
// src/adapters/indicators/plugins/structure_levels/metadata.ts
import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";

export const structureLevelsMetadata: IndicatorPluginMetadata = {
  id: "structure_levels",
  displayName: "Structure levels (HH/LL + POC + FVG)",
  tag: "structure",
  shortDescription: "High/low récents + POC + Fair Value Gaps",
  longDescription:
    "Plus haut / plus bas des 50 dernières bougies (bornes structurelles), Point of Control (aimant volume profile), et Fair Value Gaps non comblés. " +
    "Trois familles de niveaux à respecter / cibler en sweep / mean-reversion.",
};
```

- [ ] **Step 5: Create `promptFragments.ts`**

```ts
// src/adapters/indicators/plugins/structure_levels/promptFragments.ts
export function detectorFragment(s: Record<string, unknown>): string | null {
  const h = s.recentHigh, l = s.recentLow, poc = s.pocPrice;
  if (typeof h !== "number" || typeof l !== "number" || typeof poc !== "number") return null;
  return [
    `**Recent range (50p)**: high=\`${h.toFixed(2)}\` low=\`${l.toFixed(2)}\`.`,
    `**POC (50p)**: \`${poc.toFixed(2)}\` — magnet / mean-reversion anchor.`,
  ].join("\n");
}

export function reviewerFragment(s: Record<string, unknown>): string | null {
  const poc = s.pocPrice;
  if (typeof poc !== "number") return null;
  return `POC \`${poc.toFixed(2)}\``;
}
```

- [ ] **Step 6: Run tests, expect 4 PASS**

```bash
bun test test/adapters/indicators/plugins/structure_levels/
```

- [ ] **Step 7: Commit**

```bash
git add src/adapters/indicators/plugins/structure_levels/ test/adapters/indicators/plugins/structure_levels/
git commit -m "feat(indicators): add structure_levels plugin (compute + prompts)"
```

---

### Task 2: Create `structure_levels/chartScript.ts` and `index.ts`

**Files:**
- Create: `src/adapters/indicators/plugins/structure_levels/chartScript.ts`
- Create: `src/adapters/indicators/plugins/structure_levels/index.ts`

- [ ] **Step 1: Create `chartScript.ts`**

```ts
// src/adapters/indicators/plugins/structure_levels/chartScript.ts
export const CHART_SCRIPT = `
(() => {
  window.__registerPlugin("structure_levels", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex, ctx) {
      return { candleSeries: ctx.candleSeries, lines: [] };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "priceLines") return;
      for (const l of handles.lines) handles.candleSeries.removePriceLine(l);
      handles.lines = contribution.lines.map((l) =>
        handles.candleSeries.createPriceLine({
          price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style,
          axisLabelVisible: l.title !== "", title: l.title,
        }));
    },
  });
})();
`;
```

- [ ] **Step 2: Create `index.ts`**

```ts
// src/adapters/indicators/plugins/structure_levels/index.ts
import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { structureLevelsMetadata } from "./metadata";
import { computeScalars, computePriceLines } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const structureLevelsPlugin: IndicatorPlugin = {
  ...structureLevelsMetadata,
  computeScalars,
  computeSeries: (c) => ({ kind: "priceLines", lines: computePriceLines(c) }),
  scalarSchemaFragment: () => ({
    recentHigh: z.number(),
    recentLow: z.number(),
    pocPrice: z.number(),
  }),
  chartScript: CHART_SCRIPT,
  chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  breakdownAxes: ["structure"],
  preFilterCriterion: "near_pivot",
};
```

- [ ] **Step 3: Run test**

```bash
bun test test/adapters/indicators/plugins/structure_levels/
```
Expected: 4 PASS.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/indicators/plugins/structure_levels/chartScript.ts src/adapters/indicators/plugins/structure_levels/index.ts
git commit -m "feat(indicators): structure_levels chart script + plugin export"
```

---

### Task 3: Update `KNOWN_INDICATOR_IDS` and registry

**Files:**
- Modify: `src/domain/schemas/WatchesConfig.ts:28-32`
- Modify: `src/adapters/indicators/IndicatorRegistry.ts`

- [ ] **Step 1: Update WatchesConfig.ts**

In `src/domain/schemas/WatchesConfig.ts`, replace the array:

```ts
export const KNOWN_INDICATOR_IDS = [
  "ema_stack", "vwap", "bollinger", "rsi", "macd", "atr", "volume",
  "swings_bos", "structure_levels", "liquidity_pools",
] as const;
```

(Removed: `recent_range`, `liquidity_pools` stays, removed: `fvg`, `poc`. Net: 12 → 10. Note: `liquidity_pools` is unchanged — it's the EQH/EQL clusters plugin, semantically distinct from FVG/POC/HH/LL.)

- [ ] **Step 2: Update IndicatorRegistry.ts**

Replace registry imports and `REGISTRY` array:

```ts
import { emaStackPlugin } from "./plugins/ema_stack";
import { vwapPlugin } from "./plugins/vwap";
import { bollingerPlugin } from "./plugins/bollinger";
import { rsiPlugin } from "./plugins/rsi";
import { macdPlugin } from "./plugins/macd";
import { atrPlugin } from "./plugins/atr";
import { volumePlugin } from "./plugins/volume";
import { swingsBosPlugin } from "./plugins/swings_bos";
import { structureLevelsPlugin } from "./plugins/structure_levels";
import { liquidityPoolsPlugin } from "./plugins/liquidity_pools";

export const REGISTRY: ReadonlyArray<IndicatorPlugin> = [
  emaStackPlugin, vwapPlugin, bollingerPlugin,
  rsiPlugin, macdPlugin, atrPlugin,
  volumePlugin,
  swingsBosPlugin, structureLevelsPlugin, liquidityPoolsPlugin,
] as const;
```

- [ ] **Step 3: Verify the existing registry sanity test**

The test `test/adapters/indicators/IndicatorRegistry.full.test.ts` asserts `registered.length === KNOWN_INDICATOR_IDS.length` and contains check for `"rsi"` / `"volume"`. It should still pass. Run:

```bash
bun test test/adapters/indicators/IndicatorRegistry.full.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add src/domain/schemas/WatchesConfig.ts src/adapters/indicators/IndicatorRegistry.ts
git commit -m "refactor(indicators): swap fvg+poc+recent_range for structure_levels"
```

---

### Task 4: Delete old `fvg`, `poc`, `recent_range` plugins

**Files:**
- Delete: `src/adapters/indicators/plugins/fvg/`
- Delete: `src/adapters/indicators/plugins/poc/`
- Delete: `src/adapters/indicators/plugins/recent_range/`
- Delete: `test/adapters/indicators/plugins/fvg/`
- Delete: `test/adapters/indicators/plugins/poc/`
- Delete: `test/adapters/indicators/plugins/recent_range/`

- [ ] **Step 1: Remove the directories**

```bash
rm -rf src/adapters/indicators/plugins/fvg/ \
       src/adapters/indicators/plugins/poc/ \
       src/adapters/indicators/plugins/recent_range/
rm -rf test/adapters/indicators/plugins/fvg/ \
       test/adapters/indicators/plugins/poc/ \
       test/adapters/indicators/plugins/recent_range/
```

- [ ] **Step 2: Update `src/shared/indicatorMetadata.ts`**

Remove the 3 imports and remove them from the `INDICATOR_METADATA` array. Add the new import:

```ts
import { structureLevelsMetadata } from "@adapters/indicators/plugins/structure_levels/metadata";
```

Remove these imports:
```ts
// DELETE these 3 lines
import { recentRangeMetadata } from "@adapters/indicators/plugins/recent_range/metadata";
import { fvgMetadata } from "@adapters/indicators/plugins/fvg/metadata";
import { pocMetadata } from "@adapters/indicators/plugins/poc/metadata";
```

Update the `INDICATOR_METADATA` array to:
```ts
export const INDICATOR_METADATA: ReadonlyArray<IndicatorPluginMetadata> = [
  emaStackMetadata, vwapMetadata, bollingerMetadata,
  rsiMetadata, macdMetadata, atrMetadata,
  volumeMetadata,
  swingsBosMetadata, structureLevelsMetadata, liquidityPoolsMetadata,
] as const;
```

- [ ] **Step 3: Update `src/client/lib/indicatorsPresets.ts`**

The current `recommended` preset is `["ema_stack", "rsi", "volume", "swings_bos"]` — already valid (no removed ids). No change needed unless you want to add `structure_levels` to recommended:

```ts
recommended: ["ema_stack", "rsi", "volume", "swings_bos", "structure_levels"] as ReadonlyArray<IndicatorId>,
```

- [ ] **Step 4: Verify build + tests**

```bash
bun tsc --noEmit
bun test test/adapters/indicators/
```
Expected: zero new TS errors, all plugin tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(indicators): remove fvg/poc/recent_range folders"
```

---

### Task 5: Update preFilter `near_pivot` ownership

**Files:**
- Modify: `src/workflows/scheduler/preFilter.ts`

The `preFilterCriterion: "near_pivot"` was on `recentRangePlugin`. Now it's on `structureLevelsPlugin`. The pre-filter logic in `preFilter.ts` reads `recentHigh` / `recentLow` from scalars — those keys are still produced (by `structure_levels` now). No change to the function body needed; only verify.

- [ ] **Step 1: Verify by inspection**

```bash
grep -n "near_pivot\|recentHigh\|recentLow" src/workflows/scheduler/preFilter.ts
```

The handling at the `near_pivot` branch reads `scalars.recentHigh` / `scalars.recentLow` — both produced by `structure_levels.computeScalars`. No change needed.

- [ ] **Step 2: Run preFilter tests**

```bash
bun test test/workflows/scheduler/preFilter.test.ts
```
Expected: 4 PASS (the pre-existing tests use `IndicatorRegistry` which now provides `structure_levels` instead of `recent_range` for the `near_pivot` criterion).

- [ ] **Step 3: No commit if no changes**

If `bun tsc --noEmit` and `bun test` are clean, no commit. Otherwise fix and commit:

```bash
git commit -am "fix(prefilter): adjust near_pivot scalar reads if needed"
```

---

## Phase 2 — `featuredFewShotExample` for 4 plugins

### Task 6: BB squeeze breakout example for `bollinger`

**Files:**
- Modify: `src/adapters/indicators/plugins/bollinger/promptFragments.ts`
- Modify: `src/adapters/indicators/plugins/bollinger/index.ts`
- Test: `test/adapters/indicators/plugins/bollinger/index.test.ts` (add a test)

- [ ] **Step 1: Add the test**

Append to `test/adapters/indicators/plugins/bollinger/index.test.ts`:

```ts
test("featuredFewShotExample contains BB squeeze breakout pattern", () => {
  const ex = bollingerPlugin.featuredFewShotExample?.();
  expect(ex).toBeTruthy();
  expect(ex!).toContain("bb_squeeze_breakout");
  expect(ex!).toContain("BB bandwidth");
  expect(ex!).toContain("confidence_breakdown");
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
bun test test/adapters/indicators/plugins/bollinger/
```
Expected: FAIL — `featuredFewShotExample` is undefined.

- [ ] **Step 3: Add `featuredFewShotExample` to promptFragments.ts**

Append to `src/adapters/indicators/plugins/bollinger/promptFragments.ts`:

```ts
export function featuredFewShotExample(): string {
  return `### Example — BB squeeze breakout (event)

BB bandwidth percentile 8 (squeeze for THIS asset) resolves bullish on volume percentile 88. BOS confirmed (close 76050 > prior swing high 75900). Aligned with daily uptrend. Target EQH 76470 (×3).

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [{
    "type": "bb_squeeze_breakout",
    "direction": "LONG",
    "pattern_category": "event",
    "expected_maturation_ticks": 2,
    "confidence_breakdown": { "trigger": 18, "structure": 15, "volume": 12 },
    "key_levels": { "entry": 76050, "invalidation": 75880, "target": 76470 },
    "initial_score": 45,
    "raw_observation": "BB bandwidth percentile 8 (squeeze) resolves bullish on volume percentile 88. BOS confirmed."
  }],
  "ignore_reason": null
}
\`\`\``;
}
```

- [ ] **Step 4: Wire it in index.ts**

In `src/adapters/indicators/plugins/bollinger/index.ts`, add the import:

```ts
import { detectorFragment, reviewerFragment, featuredFewShotExample } from "./promptFragments";
```

Add to the plugin object:

```ts
export const bollingerPlugin: IndicatorPlugin = {
  ...bollingerMetadata,
  // ... existing fields
  featuredFewShotExample,
};
```

- [ ] **Step 5: Run tests, expect PASS**

```bash
bun test test/adapters/indicators/plugins/bollinger/
```

- [ ] **Step 6: Commit**

```bash
git add src/adapters/indicators/plugins/bollinger/ test/adapters/indicators/plugins/bollinger/
git commit -m "feat(indicators): bollinger BB squeeze breakout few-shot example"
```

---

### Task 7: BOS reaction example for `swings_bos`

**Files:**
- Modify: `src/adapters/indicators/plugins/swings_bos/promptFragments.ts`
- Modify: `src/adapters/indicators/plugins/swings_bos/index.ts`
- Test: `test/adapters/indicators/plugins/swings_bos/index.test.ts` (add)

- [ ] **Step 1: Add test**

```ts
test("featuredFewShotExample contains BOS reaction pattern", () => {
  const ex = swingsBosPlugin.featuredFewShotExample?.();
  expect(ex).toBeTruthy();
  expect(ex!).toContain("bos_reaction");
  expect(ex!).toContain("BOS state");
});
```

- [ ] **Step 2: Add `featuredFewShotExample`**

Append to `src/adapters/indicators/plugins/swings_bos/promptFragments.ts`:

```ts
export function featuredFewShotExample(): string {
  return `### Example — BOS reaction with swing pivot (event)

Last swing high at 76250 (8c ago) is taken: close 76310. BOS state flipped bullish. Re-test of the broken level held. Last swing low at 75900 (12c ago) anchors invalidation.

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [{
    "type": "bos_reaction",
    "direction": "LONG",
    "pattern_category": "event",
    "expected_maturation_ticks": 2,
    "confidence_breakdown": { "trigger": 16, "structure": 18 },
    "key_levels": { "entry": 76310, "invalidation": 75900, "target": 76800 },
    "initial_score": 34,
    "raw_observation": "BOS bullish on close 76310 > swing high 76250. Re-test held. Invalidation = swing low 75900."
  }],
  "ignore_reason": null
}
\`\`\``;
}
```

- [ ] **Step 3: Wire it in index.ts**

```ts
import { detectorFragment, reviewerFragment, featuredFewShotExample } from "./promptFragments";

export const swingsBosPlugin: IndicatorPlugin = {
  // ... existing
  featuredFewShotExample,
};
```

- [ ] **Step 4: Run, commit**

```bash
bun test test/adapters/indicators/plugins/swings_bos/
git add src/adapters/indicators/plugins/swings_bos/ test/adapters/indicators/plugins/swings_bos/
git commit -m "feat(indicators): swings_bos BOS reaction few-shot example"
```

---

### Task 8: Volume climax example for `volume`

**Files:**
- Modify: `src/adapters/indicators/plugins/volume/promptFragments.ts`
- Modify: `src/adapters/indicators/plugins/volume/index.ts`
- Test: `test/adapters/indicators/plugins/volume/index.test.ts` (add)

- [ ] **Step 1: Add test**

```ts
test("featuredFewShotExample contains volume climax pattern", () => {
  const ex = volumePlugin.featuredFewShotExample?.();
  expect(ex).toBeTruthy();
  expect(ex!).toContain("volume_climax");
  expect(ex!).toContain("percentile");
});
```

- [ ] **Step 2: Add `featuredFewShotExample`**

Append to `src/adapters/indicators/plugins/volume/promptFragments.ts`:

```ts
export function featuredFewShotExample(): string {
  return `### Example — Volume climax reversal (accumulation)

Volume percentile 96 on the latest down candle (capitulation), but follow-through candle volume drops to percentile 32. Wick rejection at the recent low. Mean-reversion setup forming.

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [{
    "type": "volume_climax",
    "direction": "LONG",
    "pattern_category": "accumulation",
    "expected_maturation_ticks": 3,
    "confidence_breakdown": { "trigger": 12, "volume": 18 },
    "key_levels": { "entry": 75450, "invalidation": 75250, "target": 75900 },
    "initial_score": 30,
    "raw_observation": "Volume percentile 96 on capitulation candle, follow-through 32 — exhausted seller. Wick rejection at recent low."
  }],
  "ignore_reason": null
}
\`\`\``;
}
```

- [ ] **Step 3: Wire + run + commit**

```ts
// in index.ts
import { detectorFragment, featuredFewShotExample } from "./promptFragments";

export const volumePlugin: IndicatorPlugin = {
  // ... existing
  featuredFewShotExample,
};
```

```bash
bun test test/adapters/indicators/plugins/volume/
git add src/adapters/indicators/plugins/volume/ test/adapters/indicators/plugins/volume/
git commit -m "feat(indicators): volume climax few-shot example"
```

---

### Task 9: Sweep+reclaim example for `liquidity_pools`

**Files:**
- Modify: `src/adapters/indicators/plugins/liquidity_pools/promptFragments.ts`
- Modify: `src/adapters/indicators/plugins/liquidity_pools/index.ts`
- Test: `test/adapters/indicators/plugins/liquidity_pools/index.test.ts` (add)

- [ ] **Step 1: Add test**

```ts
test("featuredFewShotExample contains sweep+reclaim pattern", () => {
  const ex = liquidityPoolsPlugin.featuredFewShotExample?.();
  expect(ex).toBeTruthy();
  expect(ex!).toContain("liquidity_sweep");
  expect(ex!).toContain("EQH");
});
```

- [ ] **Step 2: Add `featuredFewShotExample`**

Append to `src/adapters/indicators/plugins/liquidity_pools/promptFragments.ts`:

```ts
export function featuredFewShotExample(): string {
  return `### Example — Sweep + reclaim on EQH cluster (event)

Wick took EQH 76250×3 (3-touch cluster) at 76340 then closed back below at 76200. Volume on the wick: percentile 96 (absorption). Daily downtrend + crowded long funding = squeeze fuel.

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [{
    "type": "liquidity_sweep",
    "direction": "SHORT",
    "pattern_category": "event",
    "expected_maturation_ticks": 1,
    "confidence_breakdown": { "trigger": 22, "structure": 18 },
    "key_levels": { "entry": 76200, "invalidation": 76360, "target": 75300 },
    "initial_score": 40,
    "raw_observation": "Sweep+reclaim on EQH 76250×3: wick 76340 closed 76200. Volume percentile 96 on sweep (absorption)."
  }],
  "ignore_reason": null
}
\`\`\``;
}
```

- [ ] **Step 3: Wire + run + commit**

```ts
// in index.ts
import { detectorFragment, featuredFewShotExample } from "./promptFragments";

export const liquidityPoolsPlugin: IndicatorPlugin = {
  // ... existing
  featuredFewShotExample,
};
```

```bash
bun test test/adapters/indicators/plugins/liquidity_pools/
git add src/adapters/indicators/plugins/liquidity_pools/ test/adapters/indicators/plugins/liquidity_pools/
git commit -m "feat(indicators): liquidity_pools sweep+reclaim few-shot example"
```

---

### Task 10: Verify FewShotEngine integration

**Files:**
- Test: `test/domain/services/FewShotEngine.test.ts` (extend)

- [ ] **Step 1: Add an integration test against the real registry**

Append to `test/domain/services/FewShotEngine.test.ts`:

```ts
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";

test("real registry: 4 plugins ship featured examples; capped at 3 in compose()", () => {
  const reg = new IndicatorRegistry();
  const all = reg.all();
  const featured = all
    .map((p) => p.featuredFewShotExample?.())
    .filter((s): s is string => typeof s === "string");
  expect(featured.length).toBeGreaterThanOrEqual(4);

  const eng = new FewShotEngine();
  const composed = eng.compose(all);
  const exampleCount = composed.split("### Example").length - 1;
  expect(exampleCount).toBe(2 + 3); // 2 generic + 3 plugin (cap)
});
```

- [ ] **Step 2: Run, verify PASS**

```bash
bun test test/domain/services/FewShotEngine.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add test/domain/services/FewShotEngine.test.ts
git commit -m "test(prompts): assert FewShotEngine picks featured examples from registry"
```

---

## Phase 3 — Per-plugin parameters

Architecture summary:
- `IndicatorPlugin` gains optional `paramsSchema: z.ZodObject` and `defaultParams: object`.
- `IndicatorConfigSchema` (in `WatchesConfig`) gains `params: z.record(string, unknown).optional()`.
- Plugin compute functions accept a 2nd `params` arg with their narrowed type.
- The calculator threads `watch.indicators[id].params ?? defaultParams` to each plugin.
- `inputHash` includes the params object in its hash.
- The frontend renders a generic `IndicatorParamsPanel` under each checked indicator.

### Task 11: Extend `IndicatorPlugin` contract

**Files:**
- Modify: `src/domain/services/IndicatorPlugin.ts`

- [ ] **Step 1: Add fields to the interface**

In `src/domain/services/IndicatorPlugin.ts`, extend `IndicatorPlugin`:

```ts
export interface IndicatorPlugin extends IndicatorPluginMetadata {
  // ... existing fields

  // NEW (Phase 3 — params):
  /** Zod schema for this plugin's parameters. Each leaf is one user-tunable knob. */
  readonly paramsSchema?: z.ZodObject<z.ZodRawShape>;
  /** Default values for params; matches paramsSchema. Compute uses this when params not set. */
  readonly defaultParams?: Readonly<Record<string, unknown>>;
}
```

Update `IndicatorPluginMetadata` similarly so the client gets `defaultParams` (it does NOT get `paramsSchema` — Zod is server-only — but it does get a JSON-serializable schema descriptor, see Task 17):

```ts
export interface IndicatorPluginMetadata {
  // ... existing
  readonly defaultParams?: Readonly<Record<string, unknown>>;
  /** JSON-only descriptor for client form rendering (kind, min, max, step, label). */
  readonly paramsDescriptor?: ReadonlyArray<ParamDescriptor>;
}

export type ParamDescriptor =
  | { key: string; kind: "number"; label: string; min: number; max: number; step?: number; help?: string }
  | { key: string; kind: "enum"; label: string; options: ReadonlyArray<string>; help?: string };
```

- [ ] **Step 2: Verify build**

```bash
bun tsc --noEmit
```
Expected: zero new errors. (Existing plugins have no `paramsSchema` so they remain valid.)

- [ ] **Step 3: Commit**

```bash
git add src/domain/services/IndicatorPlugin.ts
git commit -m "feat(indicators): extend contract with paramsSchema + defaultParams"
```

---

### Task 12: Add `params` field to `IndicatorConfigSchema`

**Files:**
- Modify: `src/domain/schemas/WatchesConfig.ts`
- Test: `test/domain/schemas/WatchesConfig.indicators.test.ts` (extend)

- [ ] **Step 1: Add a test**

Append to `test/domain/schemas/WatchesConfig.indicators.test.ts`:

```ts
test("indicators entry accepts a params object", () => {
  const parsed = WatchSchema.parse({
    ...baseWatch,
    indicators: { rsi: { enabled: true, params: { period: 21 } } },
  });
  expect(parsed.indicators.rsi?.params).toEqual({ period: 21 });
});

test("params is optional", () => {
  const parsed = WatchSchema.parse({
    ...baseWatch,
    indicators: { rsi: { enabled: true } },
  });
  expect(parsed.indicators.rsi?.params).toBeUndefined();
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
bun test test/domain/schemas/WatchesConfig.indicators.test.ts
```
Expected: FAIL — `params` not accepted in current schema.

- [ ] **Step 3: Update `IndicatorConfigSchema`**

In `src/domain/schemas/WatchesConfig.ts`:

```ts
const IndicatorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  params: z.record(z.string(), z.unknown()).optional(),
});
```

- [ ] **Step 4: Run test, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/domain/schemas/WatchesConfig.ts test/domain/schemas/WatchesConfig.indicators.test.ts
git commit -m "feat(schemas): IndicatorConfig.params optional record"
```

---

### Task 13: Update `IndicatorCalculator` port + `PureJsIndicatorCalculator`

**Files:**
- Modify: `src/domain/ports/IndicatorCalculator.ts`
- Modify: `src/adapters/indicators/PureJsIndicatorCalculator.ts`
- Modify: `src/domain/services/IndicatorPlugin.ts` (signature update)

- [ ] **Step 1: Update `IndicatorPlugin.computeScalars` / `computeSeries` signatures**

Change in `IndicatorPlugin.ts`:

```ts
computeScalars(candles: Candle[], params?: Record<string, unknown>): Record<string, unknown>;
computeSeries(candles: Candle[], params?: Record<string, unknown>): IndicatorSeriesContribution;
```

- [ ] **Step 2: Update the calculator**

In `PureJsIndicatorCalculator.ts`:

```ts
async compute(
  candles: Candle[],
  plugins: ReadonlyArray<IndicatorPlugin>,
  paramsByPlugin?: Readonly<Record<string, Record<string, unknown>>>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const p of plugins) {
    const params = paramsByPlugin?.[p.id] ?? p.defaultParams;
    Object.assign(out, p.computeScalars(candles, params));
  }
  return out;
}

async computeSeries(
  candles: Candle[],
  plugins: ReadonlyArray<IndicatorPlugin>,
  paramsByPlugin?: Readonly<Record<string, Record<string, unknown>>>,
): Promise<Record<string, IndicatorSeriesContribution>> {
  const out: Record<string, IndicatorSeriesContribution> = {};
  for (const p of plugins) {
    const params = paramsByPlugin?.[p.id] ?? p.defaultParams;
    out[p.id] = p.computeSeries(candles, params);
  }
  return out;
}
```

Update the port `src/domain/ports/IndicatorCalculator.ts` to match.

- [ ] **Step 3: Update callers**

In `src/workflows/scheduler/activities.ts` `computeIndicators`:

```ts
const paramsByPlugin = Object.fromEntries(
  plugins.map((p) => [p.id, watch.indicators[p.id]?.params ?? p.defaultParams ?? {}]),
);
const scalars = await calc.compute(candles, plugins, paramsByPlugin);
const series = await calc.computeSeries(candles, plugins, paramsByPlugin);
```

- [ ] **Step 4: Verify existing tests pass**

```bash
bun tsc --noEmit
bun test
```
Expected: existing tests still pass (params is optional; plugins ignore the new arg).

- [ ] **Step 5: Commit**

```bash
git add src/domain/ports/IndicatorCalculator.ts src/adapters/indicators/PureJsIndicatorCalculator.ts \
        src/domain/services/IndicatorPlugin.ts src/workflows/scheduler/activities.ts
git commit -m "feat(indicators): thread params through calculator + activities"
```

---

### Task 14: Implement params for `rsi` plugin

**Files:**
- Modify: `src/adapters/indicators/plugins/rsi/compute.ts`
- Modify: `src/adapters/indicators/plugins/rsi/metadata.ts`
- Modify: `src/adapters/indicators/plugins/rsi/index.ts`
- Test: `test/adapters/indicators/plugins/rsi/index.test.ts` (add tests)

- [ ] **Step 1: Add tests**

```ts
test("computeScalars uses default period 14 when no params", () => {
  const s = rsiPlugin.computeScalars(sampleCandles);
  expect(typeof s.rsi).toBe("number");
});

test("computeScalars accepts custom period", () => {
  const s14 = rsiPlugin.computeScalars(sampleCandles, { period: 14 });
  const s21 = rsiPlugin.computeScalars(sampleCandles, { period: 21 });
  expect(s14.rsi).not.toEqual(s21.rsi);
});

test("paramsSchema validates period range 2..50", () => {
  const result = rsiPlugin.paramsSchema!.safeParse({ period: 100 });
  expect(result.success).toBe(false);
  expect(rsiPlugin.paramsSchema!.parse({ period: 14 })).toEqual({ period: 14 });
});

test("defaultParams matches schema", () => {
  expect(rsiPlugin.paramsSchema!.parse(rsiPlugin.defaultParams!)).toEqual({ period: 14 });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

```bash
bun test test/adapters/indicators/plugins/rsi/
```

- [ ] **Step 3: Update compute.ts**

```ts
// src/adapters/indicators/plugins/rsi/compute.ts
import type { Candle } from "@domain/schemas/Candle";
import { rsi as rsiCalc, rsiSeriesAligned } from "../base/math";

export type RsiParams = { period: number };
export const RSI_DEFAULT_PARAMS: RsiParams = { period: 14 };

function readPeriod(params?: Record<string, unknown>): number {
  const p = params?.period;
  return typeof p === "number" ? p : RSI_DEFAULT_PARAMS.period;
}

export function computeRsiScalar(
  candles: Candle[],
  params?: Record<string, unknown>,
): { rsi: number } {
  return { rsi: rsiCalc(candles.map((c) => c.close), readPeriod(params)) };
}

export function computeRsiSeries(
  candles: Candle[],
  params?: Record<string, unknown>,
): (number | null)[] {
  return rsiSeriesAligned(candles.map((c) => c.close), readPeriod(params), candles.length);
}
```

- [ ] **Step 4: Update metadata.ts**

```ts
// src/adapters/indicators/plugins/rsi/metadata.ts
import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";

export const RSI_DEFAULT_PARAMS = { period: 14 };

export const rsiMetadata: IndicatorPluginMetadata = {
  id: "rsi",
  displayName: "RSI",
  tag: "momentum",
  shortDescription: "Momentum / surachat-survente",
  longDescription:
    "Oscillateur 0-100. Extrêmes < 30 / > 70 signalent surextension. " +
    "Divergences entre prix et RSI = retournement potentiel.",
  defaultParams: RSI_DEFAULT_PARAMS,
  paramsDescriptor: [
    { key: "period", kind: "number", label: "Period", min: 2, max: 50, step: 1,
      help: "Lookback window for the RSI calculation. Standard = 14." },
  ],
};
```

- [ ] **Step 5: Update index.ts**

```ts
import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { rsiMetadata, RSI_DEFAULT_PARAMS } from "./metadata";
import { computeRsiScalar, computeRsiSeries } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

const RSI_PARAMS_SCHEMA = z.object({
  period: z.number().int().min(2).max(50),
}).strict();

export const rsiPlugin: IndicatorPlugin = {
  ...rsiMetadata,
  computeScalars: (candles, params) => computeRsiScalar(candles, params),
  computeSeries: (candles, params) =>
    ({ kind: "lines", series: { rsi: computeRsiSeries(candles, params) } }),
  scalarSchemaFragment: () => ({ rsi: z.number().min(0).max(100) }),
  paramsSchema: RSI_PARAMS_SCHEMA,
  defaultParams: RSI_DEFAULT_PARAMS,
  chartScript: CHART_SCRIPT,
  chartPane: "secondary",
  secondaryPaneStretch: 13,
  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,
  preFilterCriterion: "rsi_extreme_distance",
};
```

- [ ] **Step 6: Run tests, expect PASS**

```bash
bun test test/adapters/indicators/plugins/rsi/
```

- [ ] **Step 7: Commit**

```bash
git add src/adapters/indicators/plugins/rsi/ test/adapters/indicators/plugins/rsi/
git commit -m "feat(indicators): rsi paramsSchema (period)"
```

---

### Task 15: Implement params for `ema_stack`, `bollinger`, `atr`, `macd`, `swings_bos`, `structure_levels`

For each of these 6 plugins, follow the same pattern as Task 14. The params and defaults are:

| Plugin | Params | Default |
|---|---|---|
| `ema_stack` | `period_short` (number), `period_mid` (number), `period_long` (number) | `{ period_short: 20, period_mid: 50, period_long: 200 }` (each min 2 max 500) |
| `bollinger` | `period` (number), `std_mul` (number) | `{ period: 20, std_mul: 2 }` (period 5..100, std_mul 0.5..4 step 0.1) |
| `atr` | `period` (number) | `{ period: 14 }` (min 2 max 50) |
| `macd` | `fast` (number), `slow` (number), `signal` (number) | `{ fast: 12, slow: 26, signal: 9 }` (each 2..50; cross-validation: fast < slow) |
| `swings_bos` | `lookback` (number) | `{ lookback: 2 }` (min 1 max 10) |
| `structure_levels` | `window` (number), `poc_buckets` (number) | `{ window: 50, poc_buckets: 30 }` (window 10..200, buckets 10..100) |

The `volume`, `vwap`, `liquidity_pools` plugins keep no params in v2 (their inputs are either intrinsic to the candle stream or use a fixed window matching the upstream lookback). Document this in a comment in each plugin's `index.ts`:

```ts
// (No paramsSchema — this plugin has no user-tunable knobs in v2.)
```

- [ ] **Step 1: For each of the 6 plugins (one task each, 6 commits)**

Per plugin:
- Add tests for default + custom params + paramsSchema validation.
- Update `compute.ts` to read params with a `readX(params)` helper.
- Update `metadata.ts` with `defaultParams` + `paramsDescriptor`.
- Update `index.ts` with `paramsSchema` (using `z.object({...}).strict()`) and pass-through to compute.
- Run test for that plugin.
- Commit `feat(indicators): <plugin> paramsSchema`.

For `macd`, the schema needs cross-field validation:
```ts
const MACD_PARAMS_SCHEMA = z.object({
  fast: z.number().int().min(2).max(50),
  slow: z.number().int().min(2).max(50),
  signal: z.number().int().min(2).max(50),
}).strict().refine((v) => v.fast < v.slow, {
  message: "fast period must be < slow period",
});
```

- [ ] **Step 2: Verify all plugin tests still pass**

```bash
bun test test/adapters/indicators/plugins/
```

- [ ] **Step 3: 6 commits, one per plugin**

Naming pattern: `feat(indicators): <plugin> paramsSchema`.

---

### Task 16: Update `inputHash` to include params

**Files:**
- Modify: `src/domain/services/inputHash.ts`
- Test: `test/domain/services/inputHash.test.ts` (or wherever inputHash tests live)

- [ ] **Step 1: Read existing inputHash**

```bash
grep -n "indicators\|params" src/domain/services/inputHash.ts
```

The current `inputHash` likely hashes the watch config + scalars. We need it to also include the per-plugin params (so two watches with same enabled set but different periods get different hashes).

- [ ] **Step 2: Update the hash input**

```ts
// In inputHash.ts, in the function that builds the hash payload:
const indicatorsForHash: Record<string, { enabled: boolean; params: unknown }> = {};
for (const id of Object.keys(watch.indicators)) {
  const cfg = watch.indicators[id];
  if (cfg?.enabled) {
    indicatorsForHash[id] = {
      enabled: true,
      params: cfg.params ?? null, // null = "use defaults"; explicit override appears in hash
    };
  }
}
// Include indicatorsForHash in the JSON payload that gets sha256'd.
```

- [ ] **Step 3: Add test**

Append to `test/domain/services/inputHash.test.ts` (or create if absent):

```ts
test("two watches differ only in rsi.period → different inputHash", () => {
  const w1 = makeWatch({ indicators: { rsi: { enabled: true, params: { period: 14 } } } });
  const w2 = makeWatch({ indicators: { rsi: { enabled: true, params: { period: 21 } } } });
  expect(computeInputHash(w1, fixtureCandles)).not.toBe(computeInputHash(w2, fixtureCandles));
});

test("watch without params and watch with default params produce same hash", () => {
  const w1 = makeWatch({ indicators: { rsi: { enabled: true } } });
  const w2 = makeWatch({ indicators: { rsi: { enabled: true, params: { period: 14 } } } });
  // Note: this asserts the hash treats `undefined params` and `params: {period: 14}` differently.
  // If you prefer them to be the same hash, the implementation should normalize defaults at hash time.
  expect(computeInputHash(w1, fixtureCandles)).not.toBe(computeInputHash(w2, fixtureCandles));
});
```

The second test documents the current behavior (explicit defaults differ from absent params). If you want them to be hash-equivalent, normalize in the hash function: replace `params ?? null` with `params == null ? null : (deepEqual(params, plugin.defaultParams) ? null : params)`. Decide based on which behavior is more useful (we recommend the explicit one — easier to reason about cache invalidation).

- [ ] **Step 4: Run, commit**

```bash
bun test test/domain/services/inputHash.test.ts
git add src/domain/services/inputHash.ts test/domain/services/inputHash.test.ts
git commit -m "feat(hash): inputHash includes per-plugin params"
```

---

### Task 17: Generic `IndicatorParamsPanel` React component

**Files:**
- Create: `src/client/components/watch-form/indicator-params-panel.tsx`
- Create: `src/client/lib/indicatorParams.ts`

- [ ] **Step 1: Helper module**

```tsx
// src/client/lib/indicatorParams.ts
import type { ParamDescriptor } from "@domain/services/IndicatorPlugin";

export type ParamValue = number | string;

export function isValidParamValue(d: ParamDescriptor, v: unknown): boolean {
  if (d.kind === "number") {
    return typeof v === "number" && v >= d.min && v <= d.max;
  }
  return typeof v === "string" && d.options.includes(v);
}

export function defaultParamFromDescriptor(d: ParamDescriptor): ParamValue {
  return d.kind === "number" ? d.min : d.options[0]!;
}
```

- [ ] **Step 2: Component**

```tsx
// src/client/components/watch-form/indicator-params-panel.tsx
import * as React from "react";
import { useFormContext } from "react-hook-form";
import { Input } from "@client/components/ui/input";
import { Label } from "@client/components/ui/label";
import type { IndicatorClientMetadata } from "@domain/services/IndicatorPlugin";

export function IndicatorParamsPanel({ meta }: { meta: IndicatorClientMetadata }) {
  const form = useFormContext();
  const descriptors = meta.paramsDescriptor ?? [];
  if (descriptors.length === 0) return null;

  const fieldBase = `indicators.${meta.id}.params`;

  return (
    <div className="ml-7 mt-2 space-y-2 rounded-md bg-muted/40 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        Paramètres
      </div>
      {descriptors.map((d) => {
        const fieldName = `${fieldBase}.${d.key}`;
        const defaultVal = (meta.defaultParams as Record<string, unknown>)?.[d.key];
        if (d.kind === "number") {
          return (
            <div key={d.key} className="flex items-center gap-3 text-xs">
              <Label className="w-24 shrink-0">{d.label}</Label>
              <Input
                type="number"
                min={d.min}
                max={d.max}
                step={d.step ?? 1}
                defaultValue={defaultVal as number}
                {...form.register(fieldName, { valueAsNumber: true })}
                className="h-8 w-24"
              />
              {d.help && <span className="text-muted-foreground">{d.help}</span>}
            </div>
          );
        }
        // enum (future-proof — no plugin uses this in Task 15, but keep for v3)
        return (
          <div key={d.key} className="flex items-center gap-3 text-xs">
            <Label className="w-24 shrink-0">{d.label}</Label>
            <select
              defaultValue={defaultVal as string}
              {...form.register(fieldName)}
              className="h-8 rounded-md border bg-background px-2"
            >
              {d.options.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
            {d.help && <span className="text-muted-foreground">{d.help}</span>}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
bun tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/client/components/watch-form/indicator-params-panel.tsx src/client/lib/indicatorParams.ts
git commit -m "feat(client): IndicatorParamsPanel generic component"
```

---

### Task 18: Wire `IndicatorParamsPanel` into `section-indicators.tsx`

**Files:**
- Modify: `src/client/components/watch-form/section-indicators.tsx`

- [ ] **Step 1: Import + render**

In the existing per-indicator render block of `SectionIndicators`, after the `<div className="space-y-0.5">...</div>` that holds the description, conditionally render the params panel:

```tsx
import { IndicatorParamsPanel } from "@client/components/watch-form/indicator-params-panel";

// Inside the items.map((m) => ...) block:
return (
  <div key={m.id} className="space-y-0">
    <label className="flex items-start gap-3 cursor-pointer">
      <Checkbox checked={checked} onCheckedChange={...} />
      <div className="space-y-0.5">
        <div className="font-medium">{m.displayName}</div>
        <div className="text-xs text-muted-foreground">{m.shortDescription}</div>
        <div className="text-[11px] text-muted-foreground/80">{m.longDescription}</div>
      </div>
    </label>
    {checked && <IndicatorParamsPanel meta={m} />}
  </div>
);
```

- [ ] **Step 2: Update SENSIBLE_DEFAULTS handling**

When a checkbox toggles ON, the form should auto-populate `indicators.${id}.params` with the plugin's `defaultParams`. Update the `onCheckedChange` handler:

```tsx
onCheckedChange={(v) => {
  if (v === true) {
    form.setValue(
      `indicators.${m.id}`,
      { enabled: true, params: m.defaultParams ?? undefined },
      { shouldDirty: true },
    );
  } else {
    form.setValue(`indicators.${m.id}`, { enabled: false }, { shouldDirty: true });
  }
}}
```

- [ ] **Step 3: Manual smoke**

Run the dev server. Check the wizard:
- Naked → no params panels.
- Toggle RSI on → params panel appears with `Period = 14` pre-filled.
- Change to 21 → form state has `params.period: 21`.
- Save the watch → backend receives `indicators: { rsi: { enabled: true, params: { period: 21 } } }`.

- [ ] **Step 4: Commit**

```bash
git add src/client/components/watch-form/section-indicators.tsx
git commit -m "feat(client): expand params panel under each checked indicator"
```

---

### Task 19: Migrate `src/shared/indicatorMetadata.ts` exposes `defaultParams` + `paramsDescriptor`

**Files:**
- Verify: `src/shared/indicatorMetadata.ts`

The aggregator already re-exports the metadata constants, which (after Tasks 14-15) include `defaultParams` and `paramsDescriptor`. No code change needed if the metadata is updated. But verify with a test:

- [ ] **Step 1: Add a smoke test**

Create `test/shared/indicatorMetadata.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { INDICATOR_METADATA } from "@shared/indicatorMetadata";

describe("INDICATOR_METADATA", () => {
  test("rsi metadata exposes defaultParams + paramsDescriptor", () => {
    const rsi = INDICATOR_METADATA.find((m) => m.id === "rsi")!;
    expect(rsi.defaultParams).toEqual({ period: 14 });
    expect(rsi.paramsDescriptor).toBeTruthy();
    expect(rsi.paramsDescriptor![0]!.key).toBe("period");
  });

  test("liquidity_pools has no params (no descriptor)", () => {
    const lp = INDICATOR_METADATA.find((m) => m.id === "liquidity_pools")!;
    expect(lp.paramsDescriptor).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, commit**

```bash
bun test test/shared/
git add test/shared/
git commit -m "test(shared): assert metadata exposes params for client consumption"
```

---

### Task 20: End-to-end Phase 3 verification

**Files:**
- (no new files)

- [ ] **Step 1: Full test suite**

```bash
bun test
bun tsc --noEmit
```
Expected: all unit tests pass; only pre-existing TS errors in `client/components/{asset-chart,tv-chart}.tsx` remain.

- [ ] **Step 2: Manual UI verification**

Start dev server, edit a watch:
- Open the Indicateurs tab.
- Toggle on RSI → params panel appears with `period: 14`.
- Change to 21.
- Toggle on Bollinger → see `period: 20`, `std_mul: 2`. Change std_mul to 2.5.
- Save the watch.
- Reload → values persist.
- Trigger a tick → chart shows RSI(21), BB(20, 2.5σ).
- Detector prompt logs show `**RSI (21)**` (or whatever the prompt fragment says — verify the fragment uses the actual period from compute, not the hardcoded text).

⚠️ **Concrete subtask**: the existing prompt fragments (e.g., `**RSI (14)**`) hardcode the period in the markdown. After Phase 3, the prompt should say `**RSI (${params.period})**` to match what the LLM is actually receiving. Update `promptFragments.ts` for each parameterized plugin to take params and inline the actual values.

For each parameterized plugin:
```ts
export function detectorFragment(scalars: Record<string, unknown>, params?: { period?: number }): string | null {
  const rsi = scalars.rsi;
  const period = params?.period ?? 14;
  if (typeof rsi !== "number") return null;
  return `**RSI (${period})**: \`${rsi.toFixed(2)}\` — extreme < 30 / > 70; mid-range neutral.`;
}
```

The PromptBuilder's call site needs to pass `params` to the fragment. Update `PromptBuilder.buildDetectorPrompt`:

```ts
const indicatorFragments = plugins
  .map((p) => p.detectorPromptFragment(args.scalars, args.indicatorsMatrix[p.id]?.params))
  .filter((s): s is string => s != null)
  .join("\n");
```

This requires updating the `IndicatorPlugin.detectorPromptFragment` signature in the contract:

```ts
detectorPromptFragment(
  scalars: Record<string, unknown>,
  params?: Record<string, unknown>,
): string | null;
```

- [ ] **Step 3: Update prompt fragments + PromptBuilder + tests**

After updating each plugin's `promptFragments.ts` and the PromptBuilder, re-run:

```bash
bun test test/domain/services/PromptBuilder.test.ts
bun test test/adapters/indicators/plugins/
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(prompts): inline plugin params in detector/reviewer fragments"
```

---

## Phase 4 — Empirical validation runbook

### Task 21: Write the validation runbook

**Files:**
- Create: `docs/superpowers/runbooks/2026-05-01-naked-vs-equipped-validation.md`

- [ ] **Step 1: Create the runbook**

```markdown
# Naked vs Equipped — Empirical Validation Runbook

Date: 2026-05-01

## Goal

Validate the core hypothesis that drove the indicators modularization: **does the LLM produce better trading proposals with no indicators ("naked") or with the recommended set?** Without this data, the modularization is architecturally clean but operationally untested.

## Setup

### 1. Pick a stable, liquid asset

- Recommended: BTC/USDT on Binance, 1h timeframe.
- Avoid weekends if testing < 1 week (lower liquidity, fewer signals).

### 2. Create two watches with identical config except `indicators`

Watch A: **naked**
- `id: btc-1h-naked`
- `indicators: {}`
- `analyzers.detector.fetch_higher_timeframe: true` (for fair HTF comparison)
- Same `setup_lifecycle`, `pre_filter` (mode = lenient, default thresholds), `analyzers` model selection.

Watch B: **equipped (recommended preset)**
- `id: btc-1h-equipped`
- `indicators: { ema_stack: { enabled: true }, rsi: { enabled: true }, volume: { enabled: true }, swings_bos: { enabled: true }, structure_levels: { enabled: true } }`
- All other config identical to A.

### 3. Run for a fixed window

- Minimum: 48 hours.
- Recommended: 1 week (covers full daily cycle).

## Metrics to compare

After the window closes, query the database for both watches:

### A. Setup volume
```sql
SELECT watch_id, COUNT(*) AS proposed_setups
FROM setups
WHERE watch_id IN ('btc-1h-naked', 'btc-1h-equipped')
  AND created_at >= '<start>'::timestamptz
GROUP BY watch_id;
```

### B. Setup confirmation rate
```sql
SELECT watch_id,
       COUNT(*) FILTER (WHERE status = 'CONFIRMED') AS confirmed,
       COUNT(*) FILTER (WHERE status = 'INVALIDATED') AS invalidated,
       COUNT(*) FILTER (WHERE status = 'EXPIRED') AS expired
FROM setups
WHERE watch_id IN ('btc-1h-naked', 'btc-1h-equipped')
GROUP BY watch_id;
```

### C. Setup outcome (after maturation)
```sql
SELECT watch_id, outcome, COUNT(*)
FROM setups
WHERE watch_id IN ('btc-1h-naked', 'btc-1h-equipped')
  AND outcome IS NOT NULL
GROUP BY watch_id, outcome;
```

### D. Token cost per watch
```sql
SELECT watch_id,
       SUM(prompt_tokens + completion_tokens) AS total_tokens,
       SUM(cost_usd) AS total_cost
FROM llm_calls
WHERE watch_id IN ('btc-1h-naked', 'btc-1h-equipped')
GROUP BY watch_id;
```

### E. Qualitative — read 5 setups from each

Pick the 5 highest-`initial_score` setups from each watch. Read the `raw_observation` field on each.
- Naked: are the observations creative / qualitatively different from the equipped ones?
- Equipped: do the observations cite indicator values that are absent from the naked observations?

## Decision criteria

| Outcome | Verdict |
|---------|---------|
| Equipped: more confirmed, fewer invalidated, lower cost-per-confirmation | Equipped is better. Modularization let user pick the right tradeoff (this is the expected result). |
| Naked: comparable confirmed count, lower cost, novel pattern types in raw_observation | Naked is interesting — keep iterating on prompt creativity. |
| Both: similar confirmed counts | Modularization neutral; the architecture pays off in flexibility but not in raw quality. |
| Naked: many fewer setups | Expected — naked is less guided. Verify whether the few setups it does propose are higher-quality. |

## Follow-up actions

After 1 week of data:

- If equipped wins clearly → mark `recommended` as the default UI suggestion in the wizard, deprioritize naked-mode prompt-engineering work.
- If naked wins on quality (even if fewer signals) → invest in better naked prompts (stronger creativity prompts, more visual cues in chart, etc.).
- If neutral → document the findings and let users pick based on cost preference.

Track findings in this same file as an addendum.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/2026-05-01-naked-vs-equipped-validation.md
git commit -m "docs(runbook): naked vs equipped empirical validation"
```

---

## Self-review

**Spec coverage:**
- ✅ Phase 1 (consolidation) — Tasks 1-5
- ✅ Phase 2 (featuredFewShotExample for 4 plugins) — Tasks 6-10
- ✅ Phase 3 (params per plugin + UI) — Tasks 11-20
- ✅ Phase 4 (empirical validation) — Task 21

**Placeholder scan:** none — every step has either exact code, exact commands, or a precise instruction sequence. The exception is Task 15 which covers 6 plugins with a tabular spec; each is straightforward enough that a separate task per plugin would be repetitive — the engineer can follow the Task 14 RSI exemplar.

**Type consistency check:**
- `IndicatorPlugin.computeScalars` signature: `(candles, params?)` consistent across Tasks 13, 14, 15, 20.
- `IndicatorPlugin.detectorPromptFragment` signature: `(scalars, params?)` introduced in Task 20 — consistent with the new contract change in Task 20 Step 3.
- `IndicatorConfigSchema.params` type: `z.record(z.string(), z.unknown()).optional()` consistent across Task 12 and downstream consumers.
- `IndicatorPluginMetadata.paramsDescriptor`: type `ParamDescriptor` defined in Task 11, consumed in Tasks 14, 15, 17.

**Note for engineer:** the parent branch `feat/indicators-modularization` MUST be merged into `main` before this plan executes — the new plugins (`structure_levels`) and the contract extensions assume the parent's state.
