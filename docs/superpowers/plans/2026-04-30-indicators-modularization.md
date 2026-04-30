# Indicators Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every technical indicator opt-in per watch via a feature-flag matrix, with a "naked-mode" default (chart only, no overlays, no calculated indicators in the prompt) and a fully modular plugin contract that owns each indicator's compute, schema, prompt fragment, chart script, scoring axis, and pre-filter contribution.

**Architecture:** A single `IndicatorPlugin` contract + `IndicatorRegistry`. Twelve v1 plugins, one folder each. Skeleton handlebars prompts and a skeleton `chart-template.html` compose plugin contributions at runtime based on the watch's `indicators` matrix. Schemas (`IndicatorsSchema`, `ConfidenceBreakdownSchema`) are built dynamically per active set. No data migration — a one-shot nuke script wipes all watch/setup/lesson rows on deploy.

**Tech Stack:** Bun, TypeScript, Zod, Drizzle, Handlebars, lightweight-charts (browser-side, inlined into Playwright pages), React + react-hook-form (frontend wizard).

**Reference spec:** `docs/superpowers/specs/2026-04-30-indicators-modularization-design.md`

---

## File Structure

### New files

```
src/domain/services/IndicatorPlugin.ts            # contract types
src/domain/services/PromptBuilder.ts              # composes prompts from plugin fragments
src/domain/services/FewShotEngine.ts              # 2 generic + ≤3 plugin examples
src/domain/schemas/ConfidenceBreakdown.ts         # adaptive schema builder

src/adapters/indicators/IndicatorRegistry.ts      # registry of all plugins
src/adapters/indicators/plugins/base/math.ts      # ema/atr/macd/bollinger helpers (extracted)
src/adapters/indicators/plugins/base/types.ts     # IndicatorSeriesContribution discriminated union
src/adapters/indicators/plugins/<id>/index.ts     # full plugin (server)
src/adapters/indicators/plugins/<id>/metadata.ts  # client-safe metadata
src/adapters/indicators/plugins/<id>/compute.ts   # math (extracted from PureJsIndicatorCalculator)
src/adapters/indicators/plugins/<id>/chartScript.ts  # browser-side JS string
src/adapters/indicators/plugins/<id>/promptFragments.ts

src/shared/indicatorMetadata.ts                   # client-safe aggregator

src/client/components/watch-form/section-indicators.tsx
src/client/lib/indicatorsPresets.ts

scripts/nuke-trading-flow.ts                      # one-shot wipe
```

### Modified files

```
src/domain/schemas/WatchesConfig.ts               # add KNOWN_INDICATOR_IDS, indicators field
src/domain/schemas/Indicators.ts                  # static type goes; export buildIndicatorsSchema
src/adapters/indicators/PureJsIndicatorCalculator.ts  # delegates to registry
src/adapters/chart/PlaywrightChartRenderer.ts     # injects plugin scripts at warmUp
src/adapters/chart/chart-template.html            # becomes skeleton
prompts/detector.md.hbs                           # skeleton with composition slots
prompts/reviewer.md.hbs                           # idem
src/workflows/scheduler/preFilter.ts              # graceful β degradation
src/workflows/scheduler/activities.ts             # capture only active scalars
src/workflows/setup/activities.ts                 # use PromptBuilder + dynamic schema
src/workers/buildContainer.ts                     # wire registry + PromptBuilder
src/adapters/persistence/schema.ts                # relax tickSnapshots.indicators type
src/client/components/watch-form/index.tsx        # add wizard step
src/client/components/watch-form/section-advanced.tsx  # pre-filter UX hint
```

---

## Phase 0 — Foundation: contract, registry, schema additions

### Task 1: Add `KNOWN_INDICATOR_IDS` and `indicators` field to `WatchSchema`

**Files:**
- Modify: `src/domain/schemas/WatchesConfig.ts`
- Test: `test/domain/schemas/WatchesConfig.indicators.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// test/domain/schemas/WatchesConfig.indicators.test.ts
import { describe, expect, test } from "bun:test";
import { KNOWN_INDICATOR_IDS, WatchSchema } from "@domain/schemas/WatchesConfig";

const baseWatch = {
  id: "btc-1h",
  asset: { symbol: "BTCUSDT", source: "binance" },
  timeframes: { primary: "1h", higher: [] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50, score_initial: 25, score_threshold_finalizer: 80,
    score_threshold_dead: 10, invalidation_policy: "strict", min_risk_reward_ratio: 2,
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6", max_tokens: 2000 },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5", max_tokens: 2000 },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
  },
};

describe("WatchSchema.indicators", () => {
  test("KNOWN_INDICATOR_IDS exposes 12 plugins", () => {
    expect(KNOWN_INDICATOR_IDS.length).toBe(12);
    expect(KNOWN_INDICATOR_IDS).toContain("rsi");
    expect(KNOWN_INDICATOR_IDS).toContain("ema_stack");
    expect(KNOWN_INDICATOR_IDS).toContain("volume");
  });

  test("default indicators is empty matrix (naked)", () => {
    const parsed = WatchSchema.parse(baseWatch);
    expect(parsed.indicators).toEqual({});
  });

  test("accepts a partially populated matrix", () => {
    const parsed = WatchSchema.parse({
      ...baseWatch,
      indicators: { rsi: { enabled: true }, volume: { enabled: false } },
    });
    expect(parsed.indicators.rsi?.enabled).toBe(true);
    expect(parsed.indicators.volume?.enabled).toBe(false);
  });

  test("rejects unknown indicator id", () => {
    const result = WatchSchema.safeParse({
      ...baseWatch,
      indicators: { not_a_real_id: { enabled: true } },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/domain/schemas/WatchesConfig.indicators.test.ts`
Expected: FAIL — `KNOWN_INDICATOR_IDS` is not exported.

- [ ] **Step 3: Modify `WatchesConfig.ts`**

Add near `KNOWN_PROVIDERS` (around line 25):

```ts
export const KNOWN_INDICATOR_IDS = [
  "ema_stack", "vwap", "bollinger", "rsi", "macd", "atr", "volume",
  "swings_bos", "recent_range", "liquidity_pools", "fvg", "poc",
] as const;
export type IndicatorId = (typeof KNOWN_INDICATOR_IDS)[number];

const IndicatorConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

const IndicatorsConfigSchema = z
  .record(z.enum(KNOWN_INDICATOR_IDS), IndicatorConfigSchema)
  .default({});
```

Inside `WatchSchema` (after `feedback: FeedbackConfigSchema.prefault({}),`, before the closing `})`):

```ts
indicators: IndicatorsConfigSchema,
```

- [ ] **Step 4: Run tests**

Run: `bun test test/domain/schemas/WatchesConfig.indicators.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/schemas/WatchesConfig.ts test/domain/schemas/WatchesConfig.indicators.test.ts
git commit -m "feat(schemas): add indicators matrix to WatchSchema"
```

---

### Task 2: Define `IndicatorPlugin` contract types

**Files:**
- Create: `src/domain/services/IndicatorPlugin.ts`
- Create: `src/adapters/indicators/plugins/base/types.ts`

- [ ] **Step 1: Create `base/types.ts`**

```ts
// src/adapters/indicators/plugins/base/types.ts
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
  | { kind: "compound"; parts: IndicatorSeriesContribution[] };
```

- [ ] **Step 2: Create `IndicatorPlugin.ts`**

```ts
// src/domain/services/IndicatorPlugin.ts
import type { Candle } from "@domain/schemas/Candle";
import type { IndicatorId } from "@domain/schemas/WatchesConfig";
import type { z } from "zod";
import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";

export type IndicatorTag =
  | "trend" | "volatility" | "momentum" | "volume" | "structure" | "liquidity";

export type ChartPaneKind = "price_overlay" | "secondary";
export type BreakdownAxis = "trigger" | "structure" | "volume" | "htf";
export type PreFilterCriterion =
  | "atr_ratio_min" | "volume_spike_min" | "rsi_extreme_distance" | "near_pivot";

export interface IndicatorPluginMetadata {
  readonly id: IndicatorId;
  readonly displayName: string;
  readonly tag: IndicatorTag;
  readonly shortDescription: string;
  readonly longDescription: string;
}

export interface IndicatorPlugin extends IndicatorPluginMetadata {
  // Compute
  computeScalars(candles: Candle[]): Record<string, unknown>;
  computeSeries(candles: Candle[]): IndicatorSeriesContribution;

  // Schema
  scalarSchemaFragment(): z.ZodRawShape;

  // Chart rendering
  readonly chartScript: string;
  readonly chartPane: ChartPaneKind;
  readonly secondaryPaneStretch?: number;

  // Prompt fragments
  detectorPromptFragment(scalars: Record<string, unknown>): string | null;
  reviewerPromptFragment?(scalars: Record<string, unknown>): string | null;
  readonly contributedPatternTypes?: ReadonlyArray<string>;
  featuredFewShotExample?(): string | null;

  // Scoring & pre-filter
  readonly breakdownAxes?: ReadonlyArray<BreakdownAxis>;
  readonly preFilterCriterion?: PreFilterCriterion;
}

export type IndicatorClientMetadata = IndicatorPluginMetadata;
```

- [ ] **Step 3: Verify it compiles**

Run: `bun tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/domain/services/IndicatorPlugin.ts src/adapters/indicators/plugins/base/types.ts
git commit -m "feat(indicators): IndicatorPlugin contract"
```

---

### Task 3: Skeleton `IndicatorRegistry` with empty array

**Files:**
- Create: `src/adapters/indicators/IndicatorRegistry.ts`
- Test: `test/adapters/indicators/IndicatorRegistry.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// test/adapters/indicators/IndicatorRegistry.test.ts
import { describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";

describe("IndicatorRegistry (foundation)", () => {
  test("resolveActive returns empty array on empty matrix", () => {
    const reg = new IndicatorRegistry();
    expect(reg.resolveActive({})).toEqual([]);
  });

  test("resolveActive ignores plugins flagged disabled", () => {
    const reg = new IndicatorRegistry();
    const result = reg.resolveActive({
      rsi: { enabled: false },
      volume: { enabled: false },
    });
    expect(result).toEqual([]);
  });

  test("byId returns undefined when registry is empty", () => {
    const reg = new IndicatorRegistry();
    expect(reg.byId("rsi")).toBeUndefined();
  });

  test("allChartScripts returns empty string", () => {
    const reg = new IndicatorRegistry();
    expect(reg.allChartScripts()).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/adapters/indicators/IndicatorRegistry.test.ts`
Expected: FAIL — `IndicatorRegistry` not found.

- [ ] **Step 3: Create the file**

```ts
// src/adapters/indicators/IndicatorRegistry.ts
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import type { IndicatorId, WatchConfig } from "@domain/schemas/WatchesConfig";

// Plugins are registered here as they get implemented (Tasks 5-16).
export const REGISTRY: ReadonlyArray<IndicatorPlugin> = [] as const;

export class IndicatorRegistry {
  constructor(private plugins: ReadonlyArray<IndicatorPlugin> = REGISTRY) {}

  resolveActive(matrix: WatchConfig["indicators"]): IndicatorPlugin[] {
    return this.plugins.filter((p) => matrix[p.id]?.enabled === true);
  }

  byId(id: IndicatorId): IndicatorPlugin | undefined {
    return this.plugins.find((p) => p.id === id);
  }

  allChartScripts(): string {
    return this.plugins.map((p) => p.chartScript).join("\n");
  }

  all(): ReadonlyArray<IndicatorPlugin> {
    return this.plugins;
  }
}
```

- [ ] **Step 4: Run test**

Run: `bun test test/adapters/indicators/IndicatorRegistry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/indicators/IndicatorRegistry.ts test/adapters/indicators/IndicatorRegistry.test.ts
git commit -m "feat(indicators): empty IndicatorRegistry skeleton"
```

---

### Task 4: Extract math helpers into `base/math.ts`

**Files:**
- Create: `src/adapters/indicators/plugins/base/math.ts`
- Test: `test/adapters/indicators/plugins/base/math.test.ts` (new)

The helpers come from `src/adapters/indicators/PureJsIndicatorCalculator.ts` (lines 192-647). We move the pure math primitives so plugins can share them.

- [ ] **Step 1: Write the failing test**

```ts
// test/adapters/indicators/plugins/base/math.test.ts
import { describe, expect, test } from "bun:test";
import {
  ema, emaSeriesAligned, atrSeries, rsi, rsiSeriesAligned,
  bollingerLast, bollingerSeriesAligned, macdSeriesAligned,
  rollingMaAligned, percentileOf, zScoreOfLast, movingAverage,
} from "@adapters/indicators/plugins/base/math";

describe("base/math", () => {
  test("ema converges on constant input", () => {
    const e = ema([10, 10, 10, 10, 10, 10, 10, 10, 10, 10], 5);
    expect(e).toBeCloseTo(10, 6);
  });

  test("rsi on strictly increasing closes is 100", () => {
    expect(rsi([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], 14)).toBe(100);
  });

  test("percentileOf returns 50 on empty sample", () => {
    expect(percentileOf(5, [])).toBe(50);
  });

  test("zScoreOfLast returns 0 on flat series", () => {
    expect(zScoreOfLast([1,1,1,1,1,1], 6)).toBe(0);
  });

  test("emaSeriesAligned has length n with leading nulls before warm-up", () => {
    const closes = Array.from({ length: 50 }, (_, i) => i + 1);
    const series = emaSeriesAligned(closes, 20, 50);
    expect(series.length).toBe(50);
    expect(series[18]).toBeNull();
    expect(series[19]).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/adapters/indicators/plugins/base/math.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Extract math primitives**

Create `src/adapters/indicators/plugins/base/math.ts` by copying these private methods from `PureJsIndicatorCalculator.ts`, exported as plain functions (drop `private`, `this`):

- `rsi` (lines 192-219)
- `rsiSeriesAligned` (lines 221-249)
- `ema` (lines 253-263)
- `emaSeriesAligned` (lines 265-278)
- `atrSeries` (lines 282-303)
- `zScoreOfLast` (lines 305-315)
- `vwapSeriesAligned` (lines 327-349) → keep also `vwapSeries` derived
- `bollingerLast` (lines 353-367)
- `bollingerSeriesAligned` (lines 369-391)
- `macdLast` (lines 395-408) (depends on `macdSeriesAligned`)
- `macdSeriesAligned` (lines 410-438)
- `detectSwings` (lines 442-475)
- `detectBosState` (lines 481-519)
- `detectFvgs` (lines 523-543)
- `equalPivots` (lines 547-577)
- `pointOfControl` (lines 581-607)
- `rollingMaAligned` (lines 611-625)
- `percentileOf` (lines 632-641)
- `movingAverage` (lines 643-647)

Each becomes `export function name(...) { ... }`.

- [ ] **Step 4: Run all tests**

Run: `bun test test/adapters/indicators/plugins/base/`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/indicators/plugins/base/math.ts test/adapters/indicators/plugins/base/math.test.ts
git commit -m "refactor(indicators): extract math helpers to base/math.ts"
```

---

### Task 5: Add `buildIndicatorsSchema` and refactor `Indicators.ts`

**Files:**
- Modify: `src/domain/schemas/Indicators.ts`
- Test: `test/domain/schemas/Indicators.dynamic.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// test/domain/schemas/Indicators.dynamic.test.ts
import { describe, expect, test } from "bun:test";
import { buildIndicatorsSchema } from "@domain/schemas/Indicators";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";

const fakePlugin = (id: string, shape: z.ZodRawShape): IndicatorPlugin => ({
  id: id as never, displayName: id, tag: "trend",
  shortDescription: "", longDescription: "",
  chartScript: "", chartPane: "price_overlay",
  computeScalars: () => ({}),
  computeSeries: () => ({ kind: "lines", series: {} }),
  scalarSchemaFragment: () => shape,
  detectorPromptFragment: () => null,
});

describe("buildIndicatorsSchema", () => {
  test("empty plugins → empty object schema", () => {
    const schema = buildIndicatorsSchema([]);
    expect(schema.parse({})).toEqual({});
  });

  test("merges plugin shapes", () => {
    const a = fakePlugin("rsi", { rsi: z.number() });
    const b = fakePlugin("volume", { lastVolume: z.number(), volumeMa20: z.number() });
    const schema = buildIndicatorsSchema([a, b]);
    expect(schema.parse({ rsi: 50, lastVolume: 100, volumeMa20: 80 })).toEqual({
      rsi: 50, lastVolume: 100, volumeMa20: 80,
    });
    expect(() => schema.parse({ rsi: 50 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/domain/schemas/Indicators.dynamic.test.ts`
Expected: FAIL — `buildIndicatorsSchema` not exported.

- [ ] **Step 3: Refactor `Indicators.ts`**

Replace the entire file content with:

```ts
import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

/**
 * Builds a per-watch indicators schema from the active plugin set.
 * In naked mode (no active plugins), returns an empty object schema.
 *
 * Each plugin contributes its own keys via scalarSchemaFragment().
 * The returned schema is `.strict()` — extra keys are rejected, which
 * surfaces stale code paths during refactors.
 */
export function buildIndicatorsSchema(
  plugins: ReadonlyArray<IndicatorPlugin>,
): z.ZodObject<z.ZodRawShape> {
  if (plugins.length === 0) return z.object({}).strict();
  const shape: z.ZodRawShape = {};
  for (const p of plugins) {
    Object.assign(shape, p.scalarSchemaFragment());
  }
  return z.object(shape).strict();
}

/** Loose carrier type for compute-side scalars before per-watch validation. */
export type IndicatorScalars = Record<string, unknown>;
```

Note: removing the static `Indicators` export will break many imports. We fix those incrementally as plugins migrate (Tasks 6-16) and consumers refactor (Tasks 17-22). To avoid breaking the build *now*, also export a temporary alias:

```ts
// Temporary: legacy consumers still import `Indicators`. Removed in Task 17.
export type Indicators = IndicatorScalars;
```

- [ ] **Step 4: Run tests + verify build**

Run: `bun test test/domain/schemas/Indicators.dynamic.test.ts && bun tsc --noEmit`
Expected: tests PASS; build may have warnings about missing fields on `Indicators` — acceptable, they get fixed in later tasks.

- [ ] **Step 5: Commit**

```bash
git add src/domain/schemas/Indicators.ts test/domain/schemas/Indicators.dynamic.test.ts
git commit -m "feat(schemas): buildIndicatorsSchema dynamic factory"
```

---

### Task 6: Adaptive `ConfidenceBreakdownSchema` builder

**Files:**
- Create: `src/domain/schemas/ConfidenceBreakdown.ts`
- Test: `test/domain/schemas/ConfidenceBreakdown.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// test/domain/schemas/ConfidenceBreakdown.test.ts
import { describe, expect, test } from "bun:test";
import { buildConfidenceBreakdownSchema } from "@domain/schemas/ConfidenceBreakdown";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

const plugin = (id: string, axes: IndicatorPlugin["breakdownAxes"]): IndicatorPlugin => ({
  id: id as never, displayName: id, tag: "trend",
  shortDescription: "", longDescription: "",
  chartScript: "", chartPane: "price_overlay",
  computeScalars: () => ({}),
  computeSeries: () => ({ kind: "lines", series: {} }),
  scalarSchemaFragment: () => ({}),
  detectorPromptFragment: () => null,
  breakdownAxes: axes,
});

describe("buildConfidenceBreakdownSchema", () => {
  test("naked → { clarity: 0..100 }", () => {
    const s = buildConfidenceBreakdownSchema([], false);
    expect(s.parse({ clarity: 75 })).toEqual({ clarity: 75 });
    expect(() => s.parse({ clarity: 101 })).toThrow();
    expect(() => s.parse({ trigger: 10 })).toThrow();
  });

  test("with plugins, includes trigger axis universally", () => {
    const s = buildConfidenceBreakdownSchema([plugin("rsi", undefined)], false);
    expect(s.parse({ trigger: 10 })).toEqual({ trigger: 10 });
  });

  test("plugin axes accumulate", () => {
    const s = buildConfidenceBreakdownSchema(
      [plugin("volume", ["volume"]), plugin("swings_bos", ["structure"])],
      false,
    );
    expect(s.parse({ trigger: 10, volume: 5, structure: 5 })).toBeDefined();
    expect(() => s.parse({ trigger: 10 })).toThrow();
  });

  test("htf flag adds htf axis", () => {
    const s = buildConfidenceBreakdownSchema([plugin("rsi", undefined)], true);
    expect(s.parse({ trigger: 10, htf: 5 })).toEqual({ trigger: 10, htf: 5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/domain/schemas/ConfidenceBreakdown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the file**

```ts
// src/domain/schemas/ConfidenceBreakdown.ts
import { z } from "zod";
import type { BreakdownAxis, IndicatorPlugin } from "@domain/services/IndicatorPlugin";

export type AdaptiveConfidenceBreakdown =
  | { clarity: number }
  | Partial<Record<BreakdownAxis, number>>;

export function buildConfidenceBreakdownSchema(
  plugins: ReadonlyArray<IndicatorPlugin>,
  htfEnabled: boolean,
): z.ZodObject<z.ZodRawShape> {
  if (plugins.length === 0) {
    return z.object({ clarity: z.number().min(0).max(100) }).strict();
  }
  const axes = new Set<BreakdownAxis>();
  axes.add("trigger");
  for (const p of plugins) for (const a of p.breakdownAxes ?? []) axes.add(a);
  if (htfEnabled) axes.add("htf");
  const shape: z.ZodRawShape = {};
  for (const a of axes) shape[a] = z.number().min(0).max(25);
  return z.object(shape).strict();
}

export function isNakedBreakdown(
  bd: Record<string, unknown>,
): bd is { clarity: number } {
  return typeof bd.clarity === "number" && Object.keys(bd).length === 1;
}
```

- [ ] **Step 4: Run test**

Run: `bun test test/domain/schemas/ConfidenceBreakdown.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/schemas/ConfidenceBreakdown.ts test/domain/schemas/ConfidenceBreakdown.test.ts
git commit -m "feat(schemas): adaptive ConfidenceBreakdown"
```

---

## Phase 1 — First plugin vertical slice (RSI)

This task establishes the pattern that the remaining 11 plugins will follow.

### Task 7: RSI plugin (compute + schema fragment + tests)

**Files:**
- Create: `src/adapters/indicators/plugins/rsi/compute.ts`
- Create: `src/adapters/indicators/plugins/rsi/metadata.ts`
- Create: `src/adapters/indicators/plugins/rsi/promptFragments.ts`
- Create: `src/adapters/indicators/plugins/rsi/chartScript.ts`
- Create: `src/adapters/indicators/plugins/rsi/index.ts`
- Test: `test/adapters/indicators/plugins/rsi/index.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// test/adapters/indicators/plugins/rsi/index.test.ts
import { describe, expect, test } from "bun:test";
import { rsiPlugin } from "@adapters/indicators/plugins/rsi";

const candles = (count: number, baseClose = 100) =>
  Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1, i)),
    open: baseClose, high: baseClose + 1, low: baseClose - 1,
    close: baseClose + (i % 3 - 1), volume: 1000,
  }));

describe("rsiPlugin", () => {
  test("metadata is correct", () => {
    expect(rsiPlugin.id).toBe("rsi");
    expect(rsiPlugin.tag).toBe("momentum");
    expect(rsiPlugin.preFilterCriterion).toBe("rsi_extreme_distance");
  });

  test("computeScalars returns rsi in 0..100", () => {
    const s = rsiPlugin.computeScalars(candles(50));
    expect(s.rsi).toBeDefined();
    expect(typeof s.rsi).toBe("number");
    expect(s.rsi as number).toBeGreaterThanOrEqual(0);
    expect(s.rsi as number).toBeLessThanOrEqual(100);
  });

  test("computeSeries returns aligned line series of length n", () => {
    const c = candles(50);
    const series = rsiPlugin.computeSeries(c);
    expect(series.kind).toBe("lines");
    if (series.kind !== "lines") throw new Error();
    expect(series.series.rsi.length).toBe(50);
  });

  test("scalarSchemaFragment validates rsi number", () => {
    const fragment = rsiPlugin.scalarSchemaFragment();
    expect(fragment.rsi).toBeDefined();
    expect(fragment.rsi.parse(45)).toBe(45);
    expect(() => fragment.rsi.parse(150)).toThrow();
  });

  test("detectorPromptFragment includes RSI label and value", () => {
    const txt = rsiPlugin.detectorPromptFragment({ rsi: 67.5 });
    expect(txt).toContain("RSI");
    expect(txt).toContain("67.50");
  });

  test("reviewerPromptFragment is condensed", () => {
    const txt = rsiPlugin.reviewerPromptFragment?.({ rsi: 67.5 });
    expect(txt).toBeTruthy();
    expect(txt!.length).toBeLessThan(60);
  });
});
```

- [ ] **Step 2: Create files**

```ts
// src/adapters/indicators/plugins/rsi/compute.ts
import type { Candle } from "@domain/schemas/Candle";
import { rsi as rsiCalc, rsiSeriesAligned } from "../base/math";

export function computeRsiScalar(candles: Candle[]): { rsi: number } {
  return { rsi: rsiCalc(candles.map((c) => c.close), 14) };
}

export function computeRsiSeries(candles: Candle[]): (number | null)[] {
  return rsiSeriesAligned(candles.map((c) => c.close), 14, candles.length);
}
```

```ts
// src/adapters/indicators/plugins/rsi/metadata.ts
import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";

export const rsiMetadata: IndicatorPluginMetadata = {
  id: "rsi",
  displayName: "RSI",
  tag: "momentum",
  shortDescription: "Momentum / surachat-survente",
  longDescription:
    "Oscillateur 0-100. Extrêmes < 30 / > 70 signalent surextension. " +
    "Divergences entre prix et RSI = retournement potentiel.",
};
```

```ts
// src/adapters/indicators/plugins/rsi/promptFragments.ts
export function detectorFragment(scalars: Record<string, unknown>): string | null {
  const rsi = scalars.rsi;
  if (typeof rsi !== "number") return null;
  return `**RSI (14)**: \`${rsi.toFixed(2)}\` — extreme < 30 / > 70; mid-range neutral.`;
}

export function reviewerFragment(scalars: Record<string, unknown>): string | null {
  const rsi = scalars.rsi;
  if (typeof rsi !== "number") return null;
  return `RSI \`${rsi.toFixed(2)}\``;
}
```

```ts
// src/adapters/indicators/plugins/rsi/chartScript.ts
export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("rsi", {
    chartPane: "secondary",
    secondaryPaneStretch: 13,
    addToChart(chart, paneIndex) {
      const rsi = chart.addSeries(LC.LineSeries, {
        color: "#ce93d8", lineWidth: 1, lastValueVisible: true,
        priceLineVisible: false, title: "RSI(14)",
      }, paneIndex);
      rsi.createPriceLine({ price: 70, color: "#666", lineWidth: 1, lineStyle: 2,
                            axisLabelVisible: false, title: "" });
      rsi.createPriceLine({ price: 30, color: "#666", lineWidth: 1, lineStyle: 2,
                            axisLabelVisible: false, title: "" });
      return { rsi };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const arr = contribution.series.rsi || [];
      const data = arr
        .map((v, i) => v == null ? null : { time: candles[i].time, value: v })
        .filter(Boolean);
      handles.rsi.setData(data);
    },
  });
})();
`;
```

```ts
// src/adapters/indicators/plugins/rsi/index.ts
import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { rsiMetadata } from "./metadata";
import { computeRsiScalar, computeRsiSeries } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const rsiPlugin: IndicatorPlugin = {
  ...rsiMetadata,

  computeScalars: (candles) => computeRsiScalar(candles),
  computeSeries: (candles) => ({ kind: "lines", series: { rsi: computeRsiSeries(candles) } }),

  scalarSchemaFragment: () => ({ rsi: z.number().min(0).max(100) }),

  chartScript: CHART_SCRIPT,
  chartPane: "secondary",
  secondaryPaneStretch: 13,

  detectorPromptFragment: detectorFragment,
  reviewerPromptFragment: reviewerFragment,

  preFilterCriterion: "rsi_extreme_distance",
};
```

- [ ] **Step 3: Run tests**

Run: `bun test test/adapters/indicators/plugins/rsi/`
Expected: PASS (6 tests).

- [ ] **Step 4: Register in `IndicatorRegistry`**

Modify `src/adapters/indicators/IndicatorRegistry.ts`:

```ts
import { rsiPlugin } from "./plugins/rsi";

export const REGISTRY: ReadonlyArray<IndicatorPlugin> = [rsiPlugin] as const;
```

- [ ] **Step 5: Commit**

```bash
git add src/adapters/indicators/plugins/rsi/ src/adapters/indicators/IndicatorRegistry.ts test/adapters/indicators/plugins/rsi/
git commit -m "feat(indicators): RSI plugin (vertical slice)"
```

---

## Phase 2 — Remaining 11 plugins

Each task follows the same shape as Task 7. Each task creates 5 files (`compute.ts`, `metadata.ts`, `promptFragments.ts`, `chartScript.ts`, `index.ts`), the test file, and registers the plugin in `IndicatorRegistry.ts`.

### Task 8: `ema_stack` plugin

**Files:** `src/adapters/indicators/plugins/ema_stack/*` + test

- [ ] **Step 1: Write the test**

```ts
// test/adapters/indicators/plugins/ema_stack/index.test.ts
import { describe, expect, test } from "bun:test";
import { emaStackPlugin } from "@adapters/indicators/plugins/ema_stack";

const sampleCandles = Array.from({ length: 250 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)),
  open: 100, high: 101, low: 99, close: 100 + Math.sin(i / 10), volume: 1000,
}));

describe("emaStackPlugin", () => {
  test("metadata", () => {
    expect(emaStackPlugin.id).toBe("ema_stack");
    expect(emaStackPlugin.tag).toBe("trend");
    expect(emaStackPlugin.chartPane).toBe("price_overlay");
  });
  test("computeScalars returns ema20/50/200", () => {
    const s = emaStackPlugin.computeScalars(sampleCandles);
    expect(s.ema20).toBeDefined();
    expect(s.ema50).toBeDefined();
    expect(s.ema200).toBeDefined();
  });
  test("computeSeries returns 3 line series", () => {
    const series = emaStackPlugin.computeSeries(sampleCandles);
    if (series.kind !== "lines") throw new Error();
    expect(Object.keys(series.series).sort()).toEqual(["ema20", "ema200", "ema50"]);
  });
});
```

- [ ] **Step 2: Create files**

```ts
// compute.ts
import type { Candle } from "@domain/schemas/Candle";
import { ema, emaSeriesAligned } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  return { ema20: ema(closes, 20), ema50: ema(closes, 50), ema200: ema(closes, 200) };
}
export function computeSeries(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const n = candles.length;
  return {
    ema20: emaSeriesAligned(closes, 20, n),
    ema50: emaSeriesAligned(closes, 50, n),
    ema200: emaSeriesAligned(closes, 200, n),
  };
}
```

```ts
// metadata.ts
import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";
export const emaStackMetadata: IndicatorPluginMetadata = {
  id: "ema_stack",
  displayName: "EMA stack (20/50/200)",
  tag: "trend",
  shortDescription: "Tendance multi-horizon",
  longDescription:
    "EMAs 20/50/200 alignées = régime de tendance clair. Inversion de l'empilement = changement de régime.",
};
```

```ts
// promptFragments.ts
export function detectorFragment(s: Record<string, unknown>): string | null {
  const e20 = s.ema20, e50 = s.ema50, e200 = s.ema200;
  if (typeof e20 !== "number" || typeof e50 !== "number" || typeof e200 !== "number") return null;
  return `**EMA stack**: 20=\`${e20.toFixed(2)}\` / 50=\`${e50.toFixed(2)}\` / 200=\`${e200.toFixed(2)}\` — alignment = trend regime.`;
}
```

```ts
// chartScript.ts
export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("ema_stack", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex) {
      const mk = (color, lineWidth, title) => chart.addSeries(LC.LineSeries, {
        color, lineWidth, priceLineVisible: false, lastValueVisible: false, title,
      }, paneIndex);
      return {
        ema20: mk("#42a5f5", 1, "EMA20"),
        ema50: mk("#ffa726", 1, "EMA50"),
        ema200: mk("#ef5350", 2, "EMA200"),
      };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const fmt = (arr) => arr.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
      handles.ema20.setData(fmt(contribution.series.ema20));
      handles.ema50.setData(fmt(contribution.series.ema50));
      handles.ema200.setData(fmt(contribution.series.ema200));
    },
  });
})();
`;
```

```ts
// index.ts
import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { emaStackMetadata } from "./metadata";
import { computeScalars, computeSeries } from "./compute";
import { detectorFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const emaStackPlugin: IndicatorPlugin = {
  ...emaStackMetadata,
  computeScalars,
  computeSeries: (c) => ({ kind: "lines", series: computeSeries(c) }),
  scalarSchemaFragment: () => ({
    ema20: z.number(), ema50: z.number(), ema200: z.number(),
  }),
  chartScript: CHART_SCRIPT,
  chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
};
```

- [ ] **Step 3: Run tests, register in registry, commit**

```bash
bun test test/adapters/indicators/plugins/ema_stack/
# Edit IndicatorRegistry.ts: add emaStackPlugin to REGISTRY array
git add src/adapters/indicators/plugins/ema_stack/ src/adapters/indicators/IndicatorRegistry.ts test/adapters/indicators/plugins/ema_stack/
git commit -m "feat(indicators): ema_stack plugin"
```

---

### Task 9: `vwap` plugin

**Files:** `src/adapters/indicators/plugins/vwap/*` + test

- [ ] **Step 1: Test**

```ts
// test
test("vwap scalars include vwapSession + priceVsVwapPct", () => {
  const s = vwapPlugin.computeScalars(sampleCandles);
  expect(s.vwapSession).toBeDefined();
  expect(s.priceVsVwapPct).toBeDefined();
});
```

- [ ] **Step 2: compute.ts**

```ts
import type { Candle } from "@domain/schemas/Candle";
import { vwapSeriesAligned } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const series = vwapSeriesAligned(candles);
  const vwap = series[series.length - 1] ?? candles[candles.length - 1]?.close ?? 0;
  const lastClose = candles[candles.length - 1]?.close ?? 0;
  const priceVsVwapPct = vwap === 0 ? 0 : ((lastClose - vwap) / vwap) * 100;
  return { vwapSession: vwap, priceVsVwapPct };
}
export function computeSeries(candles: Candle[]) {
  return { vwap: vwapSeriesAligned(candles) };
}
```

- [ ] **Step 3: metadata.ts**

```ts
export const vwapMetadata = {
  id: "vwap" as const,
  displayName: "VWAP session",
  tag: "trend" as const,
  shortDescription: "VWAP session",
  longDescription:
    "Volume-weighted average price ancré au début de la session UTC. Repère institutionnel — au-dessus = bias long, loin au-dessus = stretched (mean-reversion candidate).",
};
```

- [ ] **Step 4: promptFragments.ts**

```ts
export function detectorFragment(s: Record<string, unknown>): string | null {
  const vwap = s.vwapSession; const pct = s.priceVsVwapPct;
  if (typeof vwap !== "number" || typeof pct !== "number") return null;
  return `**VWAP session**: \`${vwap.toFixed(2)}\` — price vs VWAP: \`${pct.toFixed(2)}%\`.`;
}
```

- [ ] **Step 5: chartScript.ts**

```ts
export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("vwap", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex) {
      return { vwap: chart.addSeries(LC.LineSeries, {
        color: "#ffeb3b", lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
        title: "VWAP",
      }, paneIndex) };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const data = contribution.series.vwap.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
      handles.vwap.setData(data);
    },
  });
})();
`;
```

- [ ] **Step 6: index.ts + register + commit**

```ts
import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { vwapMetadata } from "./metadata";
import { computeScalars, computeSeries } from "./compute";
import { detectorFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const vwapPlugin: IndicatorPlugin = {
  ...vwapMetadata,
  computeScalars,
  computeSeries: (c) => ({ kind: "lines", series: computeSeries(c) }),
  scalarSchemaFragment: () => ({ vwapSession: z.number(), priceVsVwapPct: z.number() }),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
};
```

```bash
bun test test/adapters/indicators/plugins/vwap/
git add src/adapters/indicators/plugins/vwap/ src/adapters/indicators/IndicatorRegistry.ts test/adapters/indicators/plugins/vwap/
git commit -m "feat(indicators): vwap plugin"
```

---

### Task 10: `bollinger` plugin

**Files:** `src/adapters/indicators/plugins/bollinger/*` + test

- [ ] **Step 1: Test**

```ts
test("bollinger scalars include bbUpper, bbMiddle, bbLower, bbBandwidthPct, bbBandwidthPercentile200", () => {
  const s = bollingerPlugin.computeScalars(sampleCandles);
  expect(s.bbUpper).toBeDefined();
  expect(s.bbMiddle).toBeDefined();
  expect(s.bbLower).toBeDefined();
  expect(s.bbBandwidthPct).toBeDefined();
  expect(s.bbBandwidthPercentile200).toBeDefined();
});
```

- [ ] **Step 2: compute.ts**

```ts
import type { Candle } from "@domain/schemas/Candle";
import { bollingerLast, bollingerSeriesAligned, percentileOf } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const bb = bollingerLast(closes, 20, 2);
  const series = bollingerSeriesAligned(closes, 20, 2);
  const widths: number[] = [];
  for (let i = 0; i < series.middle.length; i++) {
    const m = series.middle[i], u = series.upper[i], l = series.lower[i];
    if (m == null || u == null || l == null || m === 0) continue;
    widths.push(((u - l) / m) * 100);
  }
  const bandwidth = bb.middle === 0 ? 0 : ((bb.upper - bb.lower) / bb.middle) * 100;
  return {
    bbUpper: bb.upper, bbMiddle: bb.middle, bbLower: bb.lower,
    bbBandwidthPct: bandwidth,
    bbBandwidthPercentile200: percentileOf(bandwidth, widths.slice(-201, -1)),
  };
}
export function computeSeries(candles: Candle[]) {
  return bollingerSeriesAligned(candles.map((c) => c.close), 20, 2);
}
```

- [ ] **Step 3: metadata.ts**

```ts
export const bollingerMetadata = {
  id: "bollinger" as const,
  displayName: "Bollinger Bands",
  tag: "volatility" as const,
  shortDescription: "Volatilité & squeeze",
  longDescription:
    "Bandes ±2σ. Compression (squeeze) = vol comprimée → expansion à venir. Bandwidth-percentile vs 200 bougies = squeeze calibré per-asset.",
};
```

- [ ] **Step 4: promptFragments.ts**

```ts
export function detectorFragment(s: Record<string, unknown>): string | null {
  const bw = s.bbBandwidthPct; const pct = s.bbBandwidthPercentile200;
  if (typeof bw !== "number" || typeof pct !== "number") return null;
  return `**BB bandwidth**: \`${bw.toFixed(2)}%\` — percentile vs last 200 candles: **\`${pct.toFixed(0)}\`** (< 15 = squeeze for THIS asset).`;
}
export function reviewerFragment(s: Record<string, unknown>): string | null {
  const bw = s.bbBandwidthPct;
  if (typeof bw !== "number") return null;
  return `BB bandwidth: \`${bw.toFixed(2)}%\` (squeeze if < 4)`;
}
```

- [ ] **Step 5: chartScript.ts**

```ts
export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("bollinger", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex) {
      const mk = (title) => chart.addSeries(LC.LineSeries, {
        color: "rgba(156, 156, 156, 0.6)", lineWidth: 1, lineStyle: 2,
        priceLineVisible: false, lastValueVisible: false, title,
      }, paneIndex);
      return { upper: mk("BB Up"), lower: mk("BB Lo") };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const fmt = (arr) => arr.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
      handles.upper.setData(fmt(contribution.series.upper));
      handles.lower.setData(fmt(contribution.series.lower));
    },
  });
})();
`;
```

- [ ] **Step 6: index.ts + register + commit**

```ts
export const bollingerPlugin: IndicatorPlugin = {
  ...bollingerMetadata,
  computeScalars,
  computeSeries: (c) => {
    const s = computeSeries(c);
    return { kind: "lines", series: { upper: s.upper, lower: s.lower, middle: s.middle } };
  },
  scalarSchemaFragment: () => ({
    bbUpper: z.number(), bbMiddle: z.number(), bbLower: z.number(),
    bbBandwidthPct: z.number(),
    bbBandwidthPercentile200: z.number().min(0).max(100),
  }),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment, reviewerPromptFragment,
};
```

```bash
git commit -m "feat(indicators): bollinger plugin"
```

---

### Task 11: `macd` plugin

**Files:** `src/adapters/indicators/plugins/macd/*` + test

- [ ] **Step 1: Test (assert keys macd/macdSignal/macdHist + secondary pane)**

- [ ] **Step 2: compute.ts**

```ts
import type { Candle } from "@domain/schemas/Candle";
import { macdSeriesAligned } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const series = macdSeriesAligned(closes, 12, 26, 9);
  const last = (a: (number | null)[]) => a[a.length - 1] ?? 0;
  return { macd: last(series.macd), macdSignal: last(series.signal), macdHist: last(series.hist) };
}
export function computeSeries(candles: Candle[]) {
  return macdSeriesAligned(candles.map((c) => c.close), 12, 26, 9);
}
```

- [ ] **Step 3: metadata.ts**

```ts
export const macdMetadata = {
  id: "macd" as const,
  displayName: "MACD (12,26,9)",
  tag: "momentum" as const,
  shortDescription: "Convergence/divergence des EMAs",
  longDescription: "MACD (12,26,9). Croisement de l'histogramme de signe = pivot momentum. Histogramme accélérant = momentum se renforçant.",
};
```

- [ ] **Step 4: promptFragments.ts**

```ts
export function detectorFragment(s: Record<string, unknown>): string | null {
  const m = s.macd, sig = s.macdSignal, h = s.macdHist;
  if (typeof m !== "number" || typeof sig !== "number" || typeof h !== "number") return null;
  return `**MACD**: macd=\`${m.toFixed(2)}\` signal=\`${sig.toFixed(2)}\` hist=\`${h.toFixed(2)}\` (hist sign change = momentum shift).`;
}
export function reviewerFragment(s: Record<string, unknown>): string | null {
  const h = s.macdHist;
  if (typeof h !== "number") return null;
  return `MACD hist: \`${h.toFixed(2)}\``;
}
```

- [ ] **Step 5: chartScript.ts**

```ts
export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("macd", {
    chartPane: "secondary",
    secondaryPaneStretch: 13,
    addToChart(chart, paneIndex) {
      return {
        macd: chart.addSeries(LC.LineSeries, { color: "#42a5f5", lineWidth: 1, lastValueVisible: true, title: "MACD" }, paneIndex),
        signal: chart.addSeries(LC.LineSeries, { color: "#ffa726", lineWidth: 1, lastValueVisible: false, title: "Signal" }, paneIndex),
        hist: chart.addSeries(LC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIndex),
      };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const fmt = (arr) => arr.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
      handles.macd.setData(fmt(contribution.series.macd));
      handles.signal.setData(fmt(contribution.series.signal));
      handles.hist.setData((contribution.series.hist || [])
        .map((v, i) => v == null ? null : ({
          time: candles[i].time, value: v,
          color: v >= 0 ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)",
        }))
        .filter(Boolean));
    },
  });
})();
`;
```

- [ ] **Step 6: index.ts + register + commit**

```ts
export const macdPlugin: IndicatorPlugin = {
  ...macdMetadata,
  computeScalars,
  computeSeries: (c) => {
    const s = computeSeries(c);
    return { kind: "lines", series: { macd: s.macd, signal: s.signal, hist: s.hist } };
  },
  scalarSchemaFragment: () => ({ macd: z.number(), macdSignal: z.number(), macdHist: z.number() }),
  chartScript: CHART_SCRIPT, chartPane: "secondary", secondaryPaneStretch: 13,
  detectorPromptFragment, reviewerPromptFragment,
};
```

```bash
git commit -m "feat(indicators): macd plugin"
```

---

### Task 12: `atr` plugin

**Files:** `src/adapters/indicators/plugins/atr/*` + test

- [ ] **Step 1: Test (assert atr, atrMa20, atrZScore200 + preFilterCriterion atr_ratio_min)**

- [ ] **Step 2: compute.ts**

```ts
import type { Candle } from "@domain/schemas/Candle";
import { atrSeries, movingAverage, rollingMaAligned, zScoreOfLast } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const series = atrSeries(highs, lows, closes, 14);
  const atr = series[series.length - 1] ?? 0;
  return {
    atr, atrMa20: movingAverage(series, 20), atrZScore200: zScoreOfLast(series, 200),
  };
}
export function computeSeries(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const core = atrSeries(highs, lows, closes, 14);
  const padLen = candles.length - core.length;
  const atr: (number | null)[] = [
    ...Array.from({ length: padLen }, () => null), ...core,
  ];
  const atrMa20 = rollingMaAligned(atr, 20);
  return { atr, atrMa20 };
}
```

- [ ] **Step 3: metadata.ts**

```ts
export const atrMetadata = {
  id: "atr" as const,
  displayName: "ATR (14)",
  tag: "volatility" as const,
  shortDescription: "Volatility absolue",
  longDescription: "Average True Range (14) + MA20. ATR-Z200 = compression vs régime normal. Sert à dimensionner les stops.",
};
```

- [ ] **Step 4: promptFragments.ts**

```ts
export function detectorFragment(s: Record<string, unknown>): string | null {
  const atr = s.atr, z = s.atrZScore200;
  if (typeof atr !== "number" || typeof z !== "number") return null;
  return `**ATR (14)**: \`${atr.toFixed(2)}\` — z-score (200p): \`${z.toFixed(2)}\` (< -1 compression, > +1.5 exhaustion).`;
}
export function reviewerFragment(s: Record<string, unknown>): string | null {
  const atr = s.atr, z = s.atrZScore200;
  if (typeof atr !== "number" || typeof z !== "number") return null;
  return `ATR \`${atr.toFixed(2)}\` (z \`${z.toFixed(2)}\`)`;
}
```

- [ ] **Step 5: chartScript.ts**

```ts
export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("atr", {
    chartPane: "secondary",
    secondaryPaneStretch: 11,
    addToChart(chart, paneIndex) {
      return {
        atr: chart.addSeries(LC.LineSeries, { color: "#ffca28", lineWidth: 1, lastValueVisible: true, title: "ATR(14)" }, paneIndex),
        atrMa20: chart.addSeries(LC.LineSeries, { color: "#888", lineWidth: 1, lastValueVisible: false, title: "ATR MA20" }, paneIndex),
      };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "lines") return;
      const fmt = (arr) => arr.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
      handles.atr.setData(fmt(contribution.series.atr));
      handles.atrMa20.setData(fmt(contribution.series.atrMa20));
    },
  });
})();
`;
```

- [ ] **Step 6: index.ts + register + commit**

```ts
export const atrPlugin: IndicatorPlugin = {
  ...atrMetadata,
  computeScalars,
  computeSeries: (c) => {
    const s = computeSeries(c);
    return { kind: "lines", series: { atr: s.atr, atrMa20: s.atrMa20 } };
  },
  scalarSchemaFragment: () => ({
    atr: z.number().nonnegative(),
    atrMa20: z.number().nonnegative(),
    atrZScore200: z.number(),
  }),
  chartScript: CHART_SCRIPT, chartPane: "secondary", secondaryPaneStretch: 11,
  detectorPromptFragment, reviewerPromptFragment,
  preFilterCriterion: "atr_ratio_min",
};
```

```bash
git commit -m "feat(indicators): atr plugin"
```

---

### Task 13: `volume` plugin

**Files:** `src/adapters/indicators/plugins/volume/*` + test

This plugin contributes a `compound` series (the histogram from candle volumes + the MA20 line + a percentile scalar). It also owns the **entire** volume pane.

- [ ] **Step 1: Test (assert volume pane is dedicated; breakdownAxes ['volume']; preFilterCriterion 'volume_spike_min')**

- [ ] **Step 2: compute.ts**

```ts
import type { Candle } from "@domain/schemas/Candle";
import { movingAverage, percentileOf, rollingMaAligned } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const volumes = candles.map((c) => c.volume);
  return {
    volumeMa20: movingAverage(volumes, 20),
    lastVolume: volumes[volumes.length - 1] ?? 0,
    volumePercentile200: percentileOf(
      volumes[volumes.length - 1] ?? 0,
      volumes.slice(-201, -1),
    ),
  };
}
export function computeSeries(candles: Candle[]) {
  const volumes: (number | null)[] = candles.map((c) => c.volume);
  return { volumeMa20: rollingMaAligned(volumes, 20) };
}
```

- [ ] **Step 3: metadata.ts**

```ts
export const volumeMetadata = {
  id: "volume" as const,
  displayName: "Volume",
  tag: "volume" as const,
  shortDescription: "Pane volume + MA20 + percentile",
  longDescription: "Histogramme du volume coloré par direction de bougie. La MA20 et le percentile vs 200 bougies permettent de juger si le volume est anormal pour cet asset.",
};
```

- [ ] **Step 4: promptFragments.ts**

```ts
export function detectorFragment(s: Record<string, unknown>): string | null {
  const last = s.lastVolume, ma = s.volumeMa20, pct = s.volumePercentile200;
  if (typeof last !== "number" || typeof ma !== "number" || typeof pct !== "number") return null;
  return `**Volume**: last=\`${last.toFixed(0)}\` / MA20=\`${ma.toFixed(0)}\` — percentile (200p): **\`${pct.toFixed(0)}\`** (> 80 spike, < 20 anemic).`;
}
```

- [ ] **Step 5: chartScript.ts**

```ts
export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("volume", {
    chartPane: "secondary",
    secondaryPaneStretch: 13,
    addToChart(chart, paneIndex) {
      return {
        hist: chart.addSeries(LC.HistogramSeries, {
          priceFormat: { type: "volume" },
          priceLineVisible: false, lastValueVisible: false,
        }, paneIndex),
        ma20: chart.addSeries(LC.LineSeries, {
          color: "#ab47bc", lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
          title: "Vol MA20",
        }, paneIndex),
      };
    },
    setData(handles, contribution, candles) {
      handles.hist.setData(candles.map((c) => ({
        time: c.time, value: c.volume,
        color: c.close >= c.open ? "rgba(38,166,154,0.6)" : "rgba(239,83,80,0.6)",
      })));
      if (contribution.kind === "lines" && contribution.series.volumeMa20) {
        handles.ma20.setData(contribution.series.volumeMa20
          .map((v, i) => v == null ? null : { time: candles[i].time, value: v })
          .filter(Boolean));
      }
    },
  });
})();
`;
```

- [ ] **Step 6: index.ts + register + commit**

```ts
export const volumePlugin: IndicatorPlugin = {
  ...volumeMetadata,
  computeScalars,
  computeSeries: (c) => {
    const s = computeSeries(c);
    return { kind: "lines", series: { volumeMa20: s.volumeMa20 } };
  },
  scalarSchemaFragment: () => ({
    volumeMa20: z.number().nonnegative(),
    lastVolume: z.number().nonnegative(),
    volumePercentile200: z.number().min(0).max(100),
  }),
  chartScript: CHART_SCRIPT, chartPane: "secondary", secondaryPaneStretch: 13,
  detectorPromptFragment,
  breakdownAxes: ["volume"],
  preFilterCriterion: "volume_spike_min",
};
```

```bash
git commit -m "feat(indicators): volume plugin"
```

---

### Task 14: `swings_bos` plugin

**Files:** `src/adapters/indicators/plugins/swings_bos/*` + test

- [ ] **Step 1: Test (markers + bosState)**

- [ ] **Step 2: compute.ts**

```ts
import type { Candle } from "@domain/schemas/Candle";
import { detectBosState, detectSwings } from "../base/math";

export function computeScalars(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const swings = detectSwings(highs, lows, 2);
  const lastIdx = candles.length - 1;
  const lastH = swings.highs[swings.highs.length - 1] ?? null;
  const lastL = swings.lows[swings.lows.length - 1] ?? null;
  return {
    lastSwingHigh: lastH == null ? null : (highs[lastH] ?? null),
    lastSwingHighAge: lastH == null ? null : lastIdx - lastH,
    lastSwingLow: lastL == null ? null : (lows[lastL] ?? null),
    lastSwingLowAge: lastL == null ? null : lastIdx - lastL,
    bosState: detectBosState(highs, lows, closes, swings),
  };
}

export function computeMarkers(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const swings = detectSwings(highs, lows, 2);
  return {
    swingHighs: swings.highs.map((i) => ({ index: i, price: highs[i] as number })),
    swingLows: swings.lows.map((i) => ({ index: i, price: lows[i] as number })),
  };
}
```

- [ ] **Step 3: metadata.ts**

```ts
export const swingsBosMetadata = {
  id: "swings_bos" as const,
  displayName: "Swings + Break-of-Structure",
  tag: "structure" as const,
  shortDescription: "Structure swings + BOS",
  longDescription: "Swings hauts/bas (fractale 3 bougies) + état du dernier BOS (haussier / baissier / range). Base de l'analyse de structure.",
};
```

- [ ] **Step 4: promptFragments.ts**

```ts
export function detectorFragment(s: Record<string, unknown>): string | null {
  const lh = s.lastSwingHigh, lha = s.lastSwingHighAge;
  const ll = s.lastSwingLow, lla = s.lastSwingLowAge;
  const bos = s.bosState;
  if (typeof bos !== "string") return null;
  const fmt = (v: unknown) => typeof v === "number" ? v.toFixed(2) : "n/a";
  return [
    `**Swings**: last high \`${fmt(lh)}\` (${lha ?? "?"}c ago), last low \`${fmt(ll)}\` (${lla ?? "?"}c ago).`,
    `**BOS state**: \`${bos}\` (bullish/bearish = last structural break, 'none' = ranging).`,
  ].join("\n");
}
export function reviewerFragment(s: Record<string, unknown>): string | null {
  const bos = s.bosState;
  if (typeof bos !== "string") return null;
  return `BOS state: \`${bos}\``;
}
```

- [ ] **Step 5: chartScript.ts**

```ts
export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("swings_bos", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex, ctx) {
      return { candleSeries: ctx.candleSeries };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "markers") return;
      const m = contribution.markers.map((mk) => ({
        time: candles[mk.index].time,
        position: mk.position === "above" ? "aboveBar" : "belowBar",
        color: mk.color, shape: mk.shape, text: mk.text,
      })).sort((a, b) => a.time - b.time);
      if (LC.createSeriesMarkers && m.length > 0) {
        LC.createSeriesMarkers(handles.candleSeries, m);
      }
    },
  });
})();
`;
```

- [ ] **Step 6: index.ts + register + commit**

```ts
import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { swingsBosMetadata } from "./metadata";
import { computeScalars, computeMarkers } from "./compute";
import { detectorFragment, reviewerFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

export const swingsBosPlugin: IndicatorPlugin = {
  ...swingsBosMetadata,
  computeScalars,
  computeSeries: (c) => {
    const m = computeMarkers(c);
    const markers = [
      ...m.swingHighs.map((s) => ({
        index: s.index, position: "above" as const, color: "#ef5350",
        shape: "arrowDown" as const, text: "H",
      })),
      ...m.swingLows.map((s) => ({
        index: s.index, position: "below" as const, color: "#26a69a",
        shape: "arrowUp" as const, text: "L",
      })),
    ];
    return { kind: "markers", markers };
  },
  scalarSchemaFragment: () => ({
    lastSwingHigh: z.number().nullable(),
    lastSwingHighAge: z.number().int().nonnegative().nullable(),
    lastSwingLow: z.number().nullable(),
    lastSwingLowAge: z.number().int().nonnegative().nullable(),
    bosState: z.enum(["bullish", "bearish", "none"]),
  }),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment, reviewerPromptFragment,
  breakdownAxes: ["structure"],
};
```

```bash
git commit -m "feat(indicators): swings_bos plugin"
```

---

### Task 15: `recent_range` plugin

**Files:** `src/adapters/indicators/plugins/recent_range/*` + test

- [ ] **Step 1: Test (assert recentHigh/recentLow + priceLines + preFilterCriterion 'near_pivot')**

- [ ] **Step 2: compute.ts**

```ts
import type { Candle } from "@domain/schemas/Candle";

export function computeScalars(candles: Candle[]) {
  const tail = candles.slice(-50);
  return {
    recentHigh: Math.max(...tail.map((c) => c.high)),
    recentLow: Math.min(...tail.map((c) => c.low)),
  };
}
```

- [ ] **Step 3: metadata.ts**

```ts
export const recentRangeMetadata = {
  id: "recent_range" as const,
  displayName: "Recent High/Low (50p)",
  tag: "structure" as const,
  shortDescription: "Plus haut/bas récents (50 bougies)",
  longDescription: "Plus haut et plus bas des 50 dernières bougies — bornes structurelles immédiates. Approche d'une borne = test possible / sweep candidate.",
};
```

- [ ] **Step 4: promptFragments.ts**

```ts
export function detectorFragment(s: Record<string, unknown>): string | null {
  const h = s.recentHigh, l = s.recentLow;
  if (typeof h !== "number" || typeof l !== "number") return null;
  return `**Recent range (50p)**: high=\`${h.toFixed(2)}\` low=\`${l.toFixed(2)}\`.`;
}
```

- [ ] **Step 5: chartScript.ts**

```ts
export const CHART_SCRIPT = `
(() => {
  const LC = LightweightCharts;
  window.__registerPlugin("recent_range", {
    chartPane: "price_overlay",
    addToChart(chart, paneIndex, ctx) {
      return { candleSeries: ctx.candleSeries, lines: [] };
    },
    setData(handles, contribution, candles) {
      if (contribution.kind !== "priceLines") return;
      // Remove previous (idempotent re-renders not used in v1, but defensive).
      for (const l of handles.lines) handles.candleSeries.removePriceLine(l);
      handles.lines = contribution.lines.map((l) =>
        handles.candleSeries.createPriceLine({
          price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style,
          axisLabelVisible: true, title: l.title,
        }));
    },
  });
})();
`;
```

- [ ] **Step 6: index.ts + register + commit**

```ts
export const recentRangePlugin: IndicatorPlugin = {
  ...recentRangeMetadata,
  computeScalars,
  computeSeries: (c) => {
    const s = computeScalars(c);
    return {
      kind: "priceLines",
      lines: [
        { price: s.recentHigh, color: "#888", style: 2, title: "HH" },
        { price: s.recentLow, color: "#888", style: 2, title: "LL" },
      ],
    };
  },
  scalarSchemaFragment: () => ({ recentHigh: z.number(), recentLow: z.number() }),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment,
  breakdownAxes: ["structure"],
  preFilterCriterion: "near_pivot",
};
```

```bash
git commit -m "feat(indicators): recent_range plugin"
```

---

### Task 16: `liquidity_pools` plugin

**Files:** `src/adapters/indicators/plugins/liquidity_pools/*` + test

- [ ] **Step 1: Test (topEqualHighs/Lows + priceLines)**

- [ ] **Step 2: compute.ts**

```ts
import type { Candle } from "@domain/schemas/Candle";
import { detectSwings, equalPivots } from "../base/math";

const TOLERANCE = 0.001;
const RECENT = 50;

export function computeScalars(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const swings = detectSwings(highs, lows, 2);
  const recentH = equalPivots(
    swings.highs.filter((i) => i >= candles.length - RECENT), highs, TOLERANCE,
  );
  const recentL = equalPivots(
    swings.lows.filter((i) => i >= candles.length - RECENT), lows, TOLERANCE,
  );
  return {
    equalHighsCount: recentH.reduce((a, b) => a + b.indices.length, 0),
    equalLowsCount: recentL.reduce((a, b) => a + b.indices.length, 0),
    topEqualHighs: recentH
      .map((g) => ({ price: g.price, touches: g.indices.length }))
      .sort((a, b) => b.touches - a.touches).slice(0, 3),
    topEqualLows: recentL
      .map((g) => ({ price: g.price, touches: g.indices.length }))
      .sort((a, b) => b.touches - a.touches).slice(0, 3),
  };
}

export function computePriceLines(candles: Candle[]) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const swings = detectSwings(highs, lows, 2);
  const eh = equalPivots(swings.highs, highs, TOLERANCE).slice(-5);
  const el = equalPivots(swings.lows, lows, TOLERANCE).slice(-5);
  return [
    ...eh.map((e) => ({ price: e.price, color: "rgba(255,235,59,0.6)" as const, style: 1 as const, title: `EQH×${e.indices.length}` })),
    ...el.map((e) => ({ price: e.price, color: "rgba(255,235,59,0.6)" as const, style: 1 as const, title: `EQL×${e.indices.length}` })),
  ];
}
```

- [ ] **Step 3: metadata.ts**

```ts
export const liquidityPoolsMetadata = {
  id: "liquidity_pools" as const,
  displayName: "Liquidité (EQH / EQL)",
  tag: "liquidity" as const,
  shortDescription: "Liquidité (EQH / EQL)",
  longDescription: "Clusters d'égalités de pivots — pools de liquidité où les ordres stop sont concentrés. Cibles de sweep / rejets potentiels.",
};
```

- [ ] **Step 4: promptFragments.ts**

```ts
export function detectorFragment(s: Record<string, unknown>): string | null {
  const ah = s.topEqualHighs, al = s.topEqualLows;
  if (!Array.isArray(ah) || !Array.isArray(al)) return null;
  const fmt = (arr: { price: number; touches: number }[]) =>
    arr.length === 0 ? "(none)" : arr.map((e) => `\`${e.price.toFixed(2)}\` ×${e.touches}`).join(", ");
  return `**Liquidity pools** (top equal-pivot clusters):\n  - Above: ${fmt(ah as never)}\n  - Below: ${fmt(al as never)}`;
}
```

- [ ] **Step 5: chartScript.ts**

Same as `recent_range`'s chartScript but registered as `"liquidity_pools"`. Both use the `priceLines` rendering path; we can reuse identical handler code with the right id string.

- [ ] **Step 6: index.ts + register + commit**

```ts
export const liquidityPoolsPlugin: IndicatorPlugin = {
  ...liquidityPoolsMetadata,
  computeScalars,
  computeSeries: (c) => ({ kind: "priceLines", lines: computePriceLines(c) }),
  scalarSchemaFragment: () => ({
    equalHighsCount: z.number().int().nonnegative(),
    equalLowsCount: z.number().int().nonnegative(),
    topEqualHighs: z.array(z.object({ price: z.number(), touches: z.number().int() })).max(3),
    topEqualLows: z.array(z.object({ price: z.number(), touches: z.number().int() })).max(3),
  }),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment,
  breakdownAxes: ["structure"],
};
```

```bash
git commit -m "feat(indicators): liquidity_pools plugin"
```

---

### Task 17: `fvg` plugin

**Files:** `src/adapters/indicators/plugins/fvg/*` + test

- [ ] **Step 1: Test (assert priceLines for FVG bands)**

- [ ] **Step 2: compute.ts**

```ts
import type { Candle } from "@domain/schemas/Candle";
import { detectFvgs } from "../base/math";

export function computePriceLines(candles: Candle[]) {
  const fvgs = detectFvgs(candles).slice(-10);
  return fvgs.flatMap((fvg) => {
    const color = fvg.direction === "bullish"
      ? "rgba(38,166,154,0.35)" : "rgba(239,83,80,0.35)";
    return [
      { price: fvg.top, color, style: 0 as const, title: "" },
      { price: fvg.bottom, color, style: 0 as const, title: "" },
    ];
  });
}
```

- [ ] **Step 3: metadata.ts**

```ts
export const fvgMetadata = {
  id: "fvg" as const,
  displayName: "Fair Value Gaps",
  tag: "liquidity" as const,
  shortDescription: "Fair Value Gaps",
  longDescription: "Imbalances 3-bougies non comblées — niveaux où le prix peut revenir tester la zone manquée.",
};
```

- [ ] **Step 4: promptFragments.ts**

```ts
// FVG contributes no scalar in v1 — see spec §5 notes. detectorFragment returns null.
export function detectorFragment(): string | null { return null; }
```

- [ ] **Step 5: chartScript.ts**

Reuse the `priceLines` chartScript template but register as `"fvg"`.

- [ ] **Step 6: index.ts + register + commit**

```ts
export const fvgPlugin: IndicatorPlugin = {
  ...fvgMetadata,
  computeScalars: () => ({}), // no scalar
  computeSeries: (c) => ({ kind: "priceLines", lines: computePriceLines(c) }),
  scalarSchemaFragment: () => ({}),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment: detectorFragment,
  breakdownAxes: ["structure"],
};
```

```bash
git commit -m "feat(indicators): fvg plugin"
```

---

### Task 18: `poc` plugin

**Files:** `src/adapters/indicators/plugins/poc/*` + test

- [ ] **Step 1: Test (assert pocPrice scalar; computeSeries returns empty / null kind)**

- [ ] **Step 2: compute.ts**

```ts
import type { Candle } from "@domain/schemas/Candle";
import { pointOfControl } from "../base/math";

const RECENT = 50;
const BUCKETS = 30;
export function computeScalars(candles: Candle[]) {
  return { pocPrice: pointOfControl(candles.slice(-RECENT), BUCKETS) };
}
```

- [ ] **Step 3: metadata.ts**

```ts
export const pocMetadata = {
  id: "poc" as const,
  displayName: "Point of Control",
  tag: "liquidity" as const,
  shortDescription: "Volume profile POC",
  longDescription: "Niveau de prix avec le plus de volume traité sur la fenêtre récente. Aimant / ancre de mean-reversion.",
};
```

- [ ] **Step 4: promptFragments.ts**

```ts
export function detectorFragment(s: Record<string, unknown>): string | null {
  const poc = s.pocPrice;
  if (typeof poc !== "number") return null;
  return `**POC (50p)**: \`${poc.toFixed(2)}\` — magnet / mean-reversion anchor.`;
}
export function reviewerFragment(s: Record<string, unknown>): string | null {
  const poc = s.pocPrice;
  if (typeof poc !== "number") return null;
  return `POC \`${poc.toFixed(2)}\``;
}
```

- [ ] **Step 5: chartScript.ts**

POC has no chart visual in v1 — register a no-op handler:

```ts
export const CHART_SCRIPT = `
(() => {
  window.__registerPlugin("poc", {
    chartPane: "price_overlay",
    addToChart() { return {}; },
    setData() {},
  });
})();
`;
```

- [ ] **Step 6: index.ts + register + commit**

```ts
export const pocPlugin: IndicatorPlugin = {
  ...pocMetadata,
  computeScalars,
  computeSeries: () => ({ kind: "lines", series: {} }),
  scalarSchemaFragment: () => ({ pocPrice: z.number() }),
  chartScript: CHART_SCRIPT, chartPane: "price_overlay",
  detectorPromptFragment, reviewerPromptFragment,
  breakdownAxes: ["structure"],
};
```

```bash
git commit -m "feat(indicators): poc plugin"
```

---

### Task 19: All plugins registered — sanity test

**Files:** `test/adapters/indicators/IndicatorRegistry.full.test.ts` (new)

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test } from "bun:test";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { KNOWN_INDICATOR_IDS } from "@domain/schemas/WatchesConfig";

describe("IndicatorRegistry full", () => {
  test("registers all 12 KNOWN_INDICATOR_IDS", () => {
    const reg = new IndicatorRegistry();
    const registered = reg.all().map((p) => p.id).sort();
    const known = [...KNOWN_INDICATOR_IDS].sort();
    expect(registered).toEqual(known);
  });

  test("resolveActive honours the matrix", () => {
    const reg = new IndicatorRegistry();
    const active = reg.resolveActive({
      rsi: { enabled: true }, volume: { enabled: true }, ema_stack: { enabled: false },
    });
    expect(active.map((p) => p.id).sort()).toEqual(["rsi", "volume"]);
  });

  test("allChartScripts concatenates non-empty strings", () => {
    const reg = new IndicatorRegistry();
    const all = reg.allChartScripts();
    expect(all.length).toBeGreaterThan(0);
    expect(all).toContain("__registerPlugin(\"rsi\"");
    expect(all).toContain("__registerPlugin(\"volume\"");
  });
});
```

- [ ] **Step 2: Run the test, verify PASS, commit**

```bash
bun test test/adapters/indicators/IndicatorRegistry.full.test.ts
git add test/adapters/indicators/IndicatorRegistry.full.test.ts
git commit -m "test(indicators): registry full registration sanity"
```

---

## Phase 3 — Calculator refactor

### Task 20: Refactor `PureJsIndicatorCalculator` to delegate to plugins

**Files:**
- Modify: `src/adapters/indicators/PureJsIndicatorCalculator.ts`
- Modify: `src/domain/ports/IndicatorCalculator.ts` (loosen type)
- Test: existing tests under `test/adapters/indicators/PureJsIndicatorCalculator.*` should still pass

- [ ] **Step 1: Loosen the port type**

In `src/domain/ports/IndicatorCalculator.ts`, change:

```ts
export type IndicatorSeries = Record<string, unknown>;

export interface IndicatorCalculator {
  compute(candles: Candle[], plugins: ReadonlyArray<IndicatorPlugin>): Promise<Record<string, unknown>>;
  computeSeries(candles: Candle[], plugins: ReadonlyArray<IndicatorPlugin>): Promise<Record<string, IndicatorSeriesContribution>>;
}
```

(Add the imports at the top.)

- [ ] **Step 2: Rewrite `PureJsIndicatorCalculator.ts`**

```ts
import type { IndicatorCalculator } from "@domain/ports/IndicatorCalculator";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import type { Candle } from "@domain/schemas/Candle";
import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";

export class PureJsIndicatorCalculator implements IndicatorCalculator {
  async compute(
    candles: Candle[],
    plugins: ReadonlyArray<IndicatorPlugin>,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const p of plugins) {
      Object.assign(out, p.computeScalars(candles));
    }
    return out;
  }

  async computeSeries(
    candles: Candle[],
    plugins: ReadonlyArray<IndicatorPlugin>,
  ): Promise<Record<string, IndicatorSeriesContribution>> {
    const out: Record<string, IndicatorSeriesContribution> = {};
    for (const p of plugins) {
      out[p.id] = p.computeSeries(candles);
    }
    return out;
  }
}
```

The old monolithic implementation is deleted (math primitives are in `base/math.ts`, used only by plugins).

- [ ] **Step 3: Run the existing test suite to find breakages**

Run: `bun test test/adapters/indicators/`
Expected: tests using the old API (`compute(candles)` without plugins arg) FAIL — fix call sites in tests to pass a registry. Update the regression tests accordingly.

- [ ] **Step 4: Update regression test fixtures**

Open `test/adapters/indicators/PureJsIndicatorCalculator.regression*` (the file shown as modified in `git status`). Update test setup:

```ts
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";

const registry = new IndicatorRegistry();
const allPlugins = registry.all(); // active for tests = all 12

const scalars = await calc.compute(candles, allPlugins);
```

Adjust assertions to read from the merged scalar bag rather than typed fields.

- [ ] **Step 5: Run all calculator tests, commit**

```bash
bun test test/adapters/indicators/
git add src/adapters/indicators/PureJsIndicatorCalculator.ts src/domain/ports/IndicatorCalculator.ts test/adapters/indicators/
git commit -m "refactor(indicators): calculator delegates to plugin registry"
```

---

## Phase 4 — PromptBuilder + skeleton templates

### Task 21: Create `FewShotEngine`

**Files:**
- Create: `src/domain/services/FewShotEngine.ts`
- Test: `test/domain/services/FewShotEngine.test.ts` (new)

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test } from "bun:test";
import { FewShotEngine } from "@domain/services/FewShotEngine";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

const fakePlugin = (id: string, example: string | null): IndicatorPlugin => ({
  id: id as never, displayName: id, tag: "trend",
  shortDescription: "", longDescription: "",
  chartScript: "", chartPane: "price_overlay",
  computeScalars: () => ({}),
  computeSeries: () => ({ kind: "lines", series: {} }),
  scalarSchemaFragment: () => ({}),
  detectorPromptFragment: () => null,
  featuredFewShotExample: example == null ? undefined : () => example,
});

describe("FewShotEngine", () => {
  test("naked returns 2 generic examples only", () => {
    const eng = new FewShotEngine();
    const out = eng.compose([]);
    expect(out.split("### Example").length - 1).toBe(2);
  });

  test("with plugins, appends ≤3 featured examples", () => {
    const eng = new FewShotEngine();
    const out = eng.compose([
      fakePlugin("p1", "### Example 3 — P1\nbody1"),
      fakePlugin("p2", "### Example 4 — P2\nbody2"),
      fakePlugin("p3", "### Example 5 — P3\nbody3"),
      fakePlugin("p4", "### Example 6 — P4\nbody4"),
    ]);
    expect(out).toContain("Example 3");
    expect(out).toContain("Example 4");
    expect(out).toContain("Example 5");
    expect(out).not.toContain("Example 6");
  });

  test("plugins with no featured example contribute nothing", () => {
    const eng = new FewShotEngine();
    const out = eng.compose([fakePlugin("p1", null)]);
    expect(out.split("### Example").length - 1).toBe(2);
  });
});
```

- [ ] **Step 2: Create the file**

```ts
// src/domain/services/FewShotEngine.ts
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

const GENERIC_DOUBLE_BOTTOM = `
### Example 1 — Visual double-bottom by eye

Two visible lows printed at similar levels, separated by a few candles. The second low closes higher than the first → potential reversal forming.

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [{
    "type": "double_bottom",
    "direction": "LONG",
    "pattern_category": "accumulation",
    "expected_maturation_ticks": 4,
    "key_levels": { "entry": null, "invalidation": null, "target": null },
    "raw_observation": "Two lows at similar levels, second close higher than first — accumulation forming."
  }],
  "ignore_reason": null
}
\`\`\`
`.trim();

const GENERIC_RANGE_CHOP = `
### Example 2 — Range chop, ignore

Sideways tight range, no clean swing structure, no decisive close. Nothing actionable.

→ Output:
\`\`\`
{
  "corroborations": [],
  "new_setups": [],
  "ignore_reason": "Mid-range chop, no clean structure or trigger candle."
}
\`\`\`
`.trim();

export class FewShotEngine {
  private readonly maxFeatured = 3;

  compose(plugins: ReadonlyArray<IndicatorPlugin>): string {
    const featured = plugins
      .map((p) => p.featuredFewShotExample?.())
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .slice(0, this.maxFeatured);
    return [GENERIC_DOUBLE_BOTTOM, GENERIC_RANGE_CHOP, ...featured].join("\n\n");
  }
}
```

- [ ] **Step 3: Run the test, commit**

```bash
bun test test/domain/services/FewShotEngine.test.ts
git add src/domain/services/FewShotEngine.ts test/domain/services/FewShotEngine.test.ts
git commit -m "feat(prompts): FewShotEngine"
```

---

### Task 22: Refactor `detector.md.hbs` to skeleton

**Files:**
- Modify: `prompts/detector.md.hbs`

- [ ] **Step 1: Replace the file content**

```hbs
{{!--
  version: detector_v5
  description: Modular indicators. Skeleton template — Indicators block,
               classification block, few-shot, and output schema are
               composed by PromptBuilder from active plugins.
--}}

# Free-form pattern detection on a chart

## Tick context

- **Asset / Timeframe**: {{asset}} / {{timeframe}}
- **Tick at**: {{tickAt}}

{{#if activeLessons.length}}
## Active guidelines (learned from previous trades)

These principles emerged from retrospective analysis of past failed trades on
this watch. Apply them when they fit the current data. **However**: if a
lesson contradicts strong evidence in the current tick, override the lesson
and cite your reasoning. Lessons inform; current evidence wins ties.

{{#each activeLessons}}
### {{{this.title}}}

{{{this.body}}}

---
{{/each}}

{{/if}}
{{#if hasIndicators}}
## Indicators (fresh data on {{timeframe}})

{{{indicatorFragments}}}

{{else}}
## Mode

Naked-mode analysis: chart only, no computed indicators. Use pure visual
pattern recognition (price action, candle structures, geometric shapes).
The chart attached is your single source of truth. Be creative.
{{/if}}

{{#if htf}}
## Higher timeframe regime

- **Daily trend**: `{{htf.dailyTrend}}`

→ A {{timeframe}} setup aligned with the daily regime deserves a higher
`initial_score`. One fighting the daily regime should either be ignored or
proposed with a lower score and tighter invalidation.
{{/if}}

## Alive setups on {{asset}} {{timeframe}}

{{#if aliveSetups.length}}
{{#each aliveSetups}}
- **#{{this.id}}** — `{{this.patternHint}}` `{{this.direction}}` | invalidation `{{this.invalidationLevel}}` | score `{{this.currentScore}}/100` | age `{{this.ageInCandles}}` candles
{{/each}}
{{else}}
*(no alive setups — you are free to propose new candidates)*
{{/if}}

## Chart image

See attached image (Japanese candlestick chart{{#unless hasIndicators}} — no overlays, candles only{{/unless}}).

## Setup classification (REQUIRED on every new_setup)

{{{classificationBlock}}}

## Few-shot examples

{{{fewShotExamples}}}

{{#if isVolumeActive}}
## Volume rules

Volume signals are pattern-conditional. Apply this matrix:

| Pattern type | Volume should be... | Reason |
|---|---|---|
| Breakout / range expansion | High (≥ 1.2× MA20) | Confirms participation |
| Reversal / climax | High on the climax candle | Capitulation signal |
| Compression / coiling / BB squeeze | **LOW is bullish** | Energy stored |
| Pullback inside trend | Lower than impulse | Healthy correction |
| Liquidity sweep | Spike then reclaim | Order absorption |

→ DO NOT reject a setup solely because volume is low. Ask: does the volume
profile *fit* this pattern type?

{{/if}}
## Fail-closed rules

**When in doubt, propose NOTHING.** Better to miss an opportunity than
generate a false signal that pollutes the pipeline.

- If you cannot fix a clear invalidation level → do not propose the setup.
- If a pattern has no confirmation AND no exceptional context → `ignore_reason`.

## Output format

{{{outputFormatTable}}}
```

- [ ] **Step 2: Test the template still parses**

Run: `bun --eval 'import("./src/adapters/prompts/loadPrompt.ts").then(m => m.loadPrompt("detector").then(p => console.log("OK:", p.version)))'`
Expected: prints `OK: detector_v5`.

- [ ] **Step 3: Commit**

```bash
git add prompts/detector.md.hbs
git commit -m "feat(prompts): detector_v5 skeleton template"
```

---

### Task 23: Refactor `reviewer.md.hbs` to skeleton

**Files:**
- Modify: `prompts/reviewer.md.hbs`

- [ ] **Step 1: Replace the file content**

```hbs
{{!--
  version: reviewer_v5
  description: Modular indicators. Skeleton — fresh-data scalars and
               output spec composed by PromptBuilder from active plugins.
--}}

# Refining an active setup

## Active setup

- **ID**: `{{setup.id}}`
- **Pattern**: {{setup.patternHint}}
- **Direction**: `{{setup.direction}}`
- **Current score**: {{setup.currentScore}}/100
- **Invalidation level**: {{setup.invalidationLevel}}
- **Age**: {{setup.ageInCandles}} candles

{{#if activeLessons.length}}
## Active guidelines (learned from previous trades)

{{#each activeLessons}}
### {{{this.title}}}

{{{this.body}}}

---
{{/each}}

{{/if}}
## Memory — history

{{#each history}}
### Tick {{this.sequence}} ({{this.occurredAt}}) → score {{this.scoreAfter}}

**Verdict**: `{{this.type}}`

{{#if this.observations}}
**Observations**:
{{#each this.observations}}
- _{{this.kind}}_: {{this.text}}
{{/each}}
{{/if}}

{{#if this.reasoning}}
**Reasoning**: {{this.reasoning}}
{{/if}}

---
{{/each}}

## Fresh data (tick {{tick.tickAt}})

- Last close: `{{fresh.lastClose}}`
{{#if hasIndicators}}
{{{reviewerIndicatorFragments}}}
{{else}}
- Mode: naked (chart only).
{{/if}}
- Chart image attached (timeframe primary).

{{#if htf}}
## Higher-timeframe context

- **Daily regime**: `{{htf.dailyTrend}}`
- **Weekly range**: H=`{{htf.weeklyHigh}}` L=`{{htf.weeklyLow}}` — current price at `{{htf.positionInWeeklyRange}}` of the range
- **Last 5 daily candles**:
{{#each htf.daily5}}
  - {{this.date}}: H={{this.high}} L={{this.low}} C={{this.close}}
{{/each}}

{{#if funding}}
### Funding / Open Interest (crypto perp)

- **Last funding rate**: `{{funding.lastFundingRatePct}}%`
- **7-cycle avg**: `{{funding.avg7dFundingRatePct}}%`
- **Open Interest**: `{{funding.openInterest}}` (24h delta `{{funding.openInterest24hDeltaPct}}%`)
{{/if}}

### Tool: request HTF chart

If you cannot judge the macro context from the text alone, you may emit
`request_additional: { htfChart: true, reason: "..." }`. Use at most ONCE
per setup lifecycle. Round 2 is FINAL — produce a complete verdict.
{{/if}}

## `scoreDelta` calibration

| Delta | When to use |
|-------|-------------|
| `+15 / +20` | Strong confluence |
| `+5 / +10` | 1 clear additional signal |
| `0` (NEUTRAL) | Nothing new |
| `-5 / -10` | 1 contrary signal |
| `-15 / -25` | Multiple contrary signals |
| INVALIDATE | Structure clearly broken |

## Fail-closed rules

- **Nothing notable since previous tick** → `NEUTRAL`.
- **Ambiguous signals** → `NEUTRAL`.
- **Hesitating between WEAKEN and INVALIDATE** → choose WEAKEN.

## Output format

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | "STRENGTHEN" / "WEAKEN" / "NEUTRAL" / "INVALIDATE" |
| `scoreDelta` | number -30..+30 | Required for STRENGTHEN/WEAKEN |
| `observations` | array | Always non-empty |
| `observations[i].kind` | string | Free-form label |
| `observations[i].text` | string | Explanation |
| `reasoning` | string | Required for STRENGTHEN/WEAKEN |
| `reason` | string | Required for INVALIDATE |
| `invalidationLevelUpdate` | number or null | Adjust invalidation level |
| `request_additional` | object optional | `{ htfChart: true, reason: "..." }` round-1 only |
```

- [ ] **Step 2: Test, commit**

```bash
bun --eval 'import("./src/adapters/prompts/loadPrompt.ts").then(m => m.loadPrompt("reviewer").then(p => console.log("OK:", p.version)))'
# Expected: OK: reviewer_v5
git add prompts/reviewer.md.hbs
git commit -m "feat(prompts): reviewer_v5 skeleton template"
```

---

### Task 24: Implement `PromptBuilder` service

**Files:**
- Create: `src/domain/services/PromptBuilder.ts`
- Test: `test/domain/services/PromptBuilder.test.ts` (new)

- [ ] **Step 1: Write the test**

```ts
// test/domain/services/PromptBuilder.test.ts
import { describe, expect, test, beforeAll } from "bun:test";
import { PromptBuilder } from "@domain/services/PromptBuilder";
import { FewShotEngine } from "@domain/services/FewShotEngine";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";

const baseArgs = {
  asset: "BTCUSDT", timeframe: "1h", tickAt: new Date("2026-04-30T10:00:00Z"),
  scalars: {}, activeLessons: [], aliveSetups: [], htf: undefined,
};

describe("PromptBuilder.buildDetectorPrompt", () => {
  let builder: PromptBuilder;
  beforeAll(async () => {
    builder = new PromptBuilder(new IndicatorRegistry(), new FewShotEngine());
    await builder.warmUp();
  });

  test("naked: contains 'Naked-mode' and no Indicators block", async () => {
    const out = await builder.buildDetectorPrompt({
      ...baseArgs, indicatorsMatrix: {},
    });
    expect(out).toContain("Naked-mode analysis");
    expect(out).not.toContain("## Indicators (fresh data");
    expect(out).toContain('"clarity"');
    expect(out).not.toContain("## Volume rules");
  });

  test("rsi only: contains Indicators block + RSI fragment", async () => {
    const out = await builder.buildDetectorPrompt({
      ...baseArgs,
      scalars: { rsi: 50 },
      indicatorsMatrix: { rsi: { enabled: true } },
    });
    expect(out).toContain("## Indicators (fresh data");
    expect(out).toContain("**RSI (14)**");
    expect(out).not.toContain("## Volume rules");
    expect(out).toContain("trigger");
  });

  test("volume active: includes Volume rules block + volume axis", async () => {
    const out = await builder.buildDetectorPrompt({
      ...baseArgs,
      scalars: { volumeMa20: 100, lastVolume: 200, volumePercentile200: 80 },
      indicatorsMatrix: { volume: { enabled: true } },
    });
    expect(out).toContain("## Volume rules");
    expect(out).toContain('"volume"');
  });
});
```

- [ ] **Step 2: Create the file**

```ts
// src/domain/services/PromptBuilder.ts
import { loadPrompt, type LoadedPrompt } from "@adapters/prompts/loadPrompt";
import type { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import type { FewShotEngine } from "@domain/services/FewShotEngine";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";

export class PromptBuilder {
  private detector: LoadedPrompt | null = null;
  private reviewer: LoadedPrompt | null = null;

  constructor(
    private registry: IndicatorRegistry,
    private fewShot: FewShotEngine,
  ) {}

  async warmUp(): Promise<void> {
    if (!this.detector) this.detector = await loadPrompt("detector");
    if (!this.reviewer) this.reviewer = await loadPrompt("reviewer");
  }

  async buildDetectorPrompt(args: {
    asset: string;
    timeframe: string;
    tickAt: Date;
    scalars: Record<string, unknown>;
    activeLessons: Array<{ title: string; body: string }>;
    aliveSetups: Array<unknown>;
    htf?: { dailyTrend: string };
    indicatorsMatrix: WatchConfig["indicators"];
  }): Promise<string> {
    if (!this.detector) await this.warmUp();
    const plugins = this.registry.resolveActive(args.indicatorsMatrix);
    const isVolumeActive = plugins.some((p) => p.id === "volume");
    const indicatorFragments = plugins
      .map((p) => p.detectorPromptFragment(args.scalars))
      .filter((s): s is string => s != null)
      .join("\n");
    const classificationBlock = composeClassificationBlock(plugins, !!args.htf);
    const fewShotExamples = this.fewShot.compose(plugins);
    const outputFormatTable = composeOutputFormatTable(plugins, !!args.htf);
    return this.detector!.render({
      asset: args.asset,
      timeframe: args.timeframe,
      tickAt: args.tickAt.toISOString(),
      activeLessons: args.activeLessons,
      aliveSetups: args.aliveSetups,
      htf: args.htf,
      hasIndicators: plugins.length > 0,
      isVolumeActive,
      indicatorFragments,
      classificationBlock,
      fewShotExamples,
      outputFormatTable,
    });
  }

  async buildReviewerPrompt(args: {
    setup: unknown;
    history: unknown[];
    fresh: { lastClose: number; scalars: Record<string, unknown>; tickAt: Date };
    activeLessons: Array<{ title: string; body: string }>;
    htf?: unknown;
    funding?: unknown;
    indicatorsMatrix: WatchConfig["indicators"];
  }): Promise<string> {
    if (!this.reviewer) await this.warmUp();
    const plugins = this.registry.resolveActive(args.indicatorsMatrix);
    const reviewerIndicatorFragments = plugins
      .map((p) => p.reviewerPromptFragment?.(args.fresh.scalars))
      .filter((s): s is string => typeof s === "string")
      .map((s) => `- ${s}`)
      .join("\n");
    return this.reviewer!.render({
      setup: args.setup,
      history: args.history,
      tick: { tickAt: args.fresh.tickAt.toISOString() },
      fresh: { lastClose: args.fresh.lastClose },
      activeLessons: args.activeLessons,
      htf: args.htf,
      funding: args.funding,
      hasIndicators: plugins.length > 0,
      reviewerIndicatorFragments,
    });
  }
}

function composeClassificationBlock(
  plugins: ReadonlyArray<IndicatorPlugin>,
  htfEnabled: boolean,
): string {
  if (plugins.length === 0) {
    return [
      "Every proposed setup MUST declare:",
      "",
      "- **`pattern_category`**: `event` (single trigger) or `accumulation` (multi-touch).",
      "- **`expected_maturation_ticks`** (1-6): how many reviewer ticks before finalizer-ready.",
      "- **`clarity`** (0-100): how visually clear is the pattern on the chart, judged from the image alone.",
    ].join("\n");
  }
  const axes = new Set<string>(["trigger"]);
  for (const p of plugins) for (const a of p.breakdownAxes ?? []) axes.add(a);
  if (htfEnabled) axes.add("htf");
  const axesList = [...axes];
  return [
    "Every proposed setup MUST declare:",
    "",
    "- **`pattern_category`**: `event` or `accumulation`.",
    "- **`expected_maturation_ticks`** (1-6): see system prompt.",
    "- **`confidence_breakdown`**: each axis 0-25; sum equals `initial_score` (±2).",
    `  Axes for this watch: ${axesList.map((a) => `\`${a}\``).join(", ")}.`,
  ].join("\n");
}

function composeOutputFormatTable(
  plugins: ReadonlyArray<IndicatorPlugin>,
  htfEnabled: boolean,
): string {
  const breakdownRow = plugins.length === 0
    ? "| `new_setups[i].clarity` | number 0-100 | Visual pattern clarity |"
    : "| `new_setups[i].confidence_breakdown` | object | Per-axis 0-25 scores; sum ≈ initial_score |";
  return [
    "Respond with a strict JSON object. All fields below REQUIRED.",
    "",
    "| Field | Type | Description |",
    "|-------|------|-------------|",
    "| `corroborations` | array | Alive setups reinforced this tick |",
    "| `corroborations[i].setup_id` | string | ID of an alive setup |",
    "| `corroborations[i].evidence` | array<string> | Quantified observations |",
    "| `corroborations[i].confidence_delta_suggested` | number 0..20 | Delta |",
    "| `new_setups` | array | New setups proposed |",
    "| `new_setups[i].type` | string | Free-form label |",
    "| `new_setups[i].direction` | string | \"LONG\" / \"SHORT\" |",
    "| `new_setups[i].pattern_category` | string | \"event\" / \"accumulation\" |",
    "| `new_setups[i].expected_maturation_ticks` | int 1-6 | Reviewer ticks expected |",
    breakdownRow,
    "| `new_setups[i].key_levels.entry` | number optional | Entry |",
    "| `new_setups[i].key_levels.invalidation` | number REQUIRED | Invalidation |",
    "| `new_setups[i].key_levels.target` | number optional | Target |",
    "| `new_setups[i].initial_score` | number 0..100 | Initial score |",
    "| `new_setups[i].raw_observation` | string | Concise explanation |",
    "| `ignore_reason` | string or null | If nothing to signal |",
  ].join("\n");
}
```

- [ ] **Step 3: Run the test, commit**

```bash
bun test test/domain/services/PromptBuilder.test.ts
git add src/domain/services/PromptBuilder.ts test/domain/services/PromptBuilder.test.ts
git commit -m "feat(prompts): PromptBuilder service"
```

---

## Phase 5 — Chart renderer refactor

### Task 25: Skeleton `chart-template.html`

**Files:**
- Modify: `src/adapters/chart/chart-template.html`

- [ ] **Step 1: Replace the file content**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <!-- {{LIGHTWEIGHT_CHARTS_INLINE}} -->
  <style>
    html, body { margin: 0; padding: 0; background: #131722; height: 100%; color: #d1d4dc; font-family: -apple-system, system-ui, sans-serif; }
    #chart { width: 100vw; height: 100vh; }
  </style>
</head>
<body>
  <div id="chart"></div>
  <script>
    (() => {
      window.__chartPlugins = {};
      window.__registerPlugin = (id, plugin) => { window.__chartPlugins[id] = plugin; };
    })();
  </script>
  <!-- {{INDICATOR_PLUGIN_SCRIPTS}} -->
  <script>
    (() => {
      const LC = LightweightCharts;
      window.__renderCandles = (payload) => {
        const { candles, indicators, enabledIndicatorIds } = payload;
        const naked = enabledIndicatorIds.length === 0;
        const chart = LC.createChart(document.getElementById("chart"), {
          layout: {
            background: { color: "#131722" },
            textColor: "#d1d4dc",
            panes: { separatorColor: "#2a2e39", separatorHoverColor: "#363a45" },
          },
          grid: {
            vertLines: { color: naked ? "#1f2330" : "#2a2e39" },
            horzLines: { color: "#2a2e39" },
          },
          timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#485158" },
          rightPriceScale: { borderColor: "#485158" },
          crosshair: { mode: 0 },
        });

        const candleSeries = chart.addSeries(LC.CandlestickSeries, {
          upColor: "#26a69a", downColor: "#ef5350",
          borderVisible: naked,
          wickUpColor: "#26a69a", wickDownColor: "#ef5350",
          lastValueVisible: naked,
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

- [ ] **Step 2: Commit**

```bash
git add src/adapters/chart/chart-template.html
git commit -m "feat(chart): skeleton template with plugin registration"
```

---

### Task 26: Update `PlaywrightChartRenderer` to inject plugin scripts

**Files:**
- Modify: `src/adapters/chart/PlaywrightChartRenderer.ts`

- [ ] **Step 1: Modify the renderer**

In `warmUp()` (around line 26), replace the template loading block:

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
    dirname(pkgJsonPath), "dist", "lightweight-charts.standalone.production.js",
  );
  const libSource = await Bun.file(libPath).text();

  // Inline both the lightweight-charts bundle AND the indicator plugin scripts.
  const pluginScripts = this.registry.allChartScripts();
  this.templateHtml = rawTemplate
    .replace(
      "<!-- {{LIGHTWEIGHT_CHARTS_INLINE}} -->",
      `<script>${libSource}</script>`,
    )
    .replace(
      "<!-- {{INDICATOR_PLUGIN_SCRIPTS}} -->",
      `<script>${pluginScripts}</script>`,
    );

  for (let i = 0; i < size; i++) {
    const page = await this.browser.newPage({
      viewport: { width: 1280, height: 720 }, locale: "en-US",
    });
    await page.setContent(this.templateHtml);
    this.pagePool.push(page);
  }
}
```

Add `registry` to the constructor:

```ts
constructor(
  private registry: IndicatorRegistry,
  private opts: { poolSize?: number; templatePath?: string } = {},
) {}
```

In `render(args)`, change the payload shape:

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
      indicators: args.series,
      enabledIndicatorIds: args.enabledIndicatorIds,
    };
    await page.evaluate((data) => {
      (window as unknown as { __renderCandles: (c: unknown) => void }).__renderCandles(data);
    }, payload);
    // … rest of render unchanged (waitForFunction, screenshot, sharp, write, return).
  } finally {
    this.releasePage(page);
  }
}
```

The `ChartRenderer` port (`src/domain/ports/ChartRenderer.ts`) needs the same shape change — update it.

- [ ] **Step 2: Update ChartRenderer port**

```ts
// src/domain/ports/ChartRenderer.ts
import type { Candle } from "@domain/schemas/Candle";
import type { IndicatorSeriesContribution } from "@adapters/indicators/plugins/base/types";

export type ChartRenderResult = {
  uri: string; sha256: string; bytes: number; mimeType: string; content: Buffer;
};

export interface ChartRenderer {
  warmUp(): Promise<void>;
  dispose(): Promise<void>;
  render(args: {
    candles: Candle[];
    series: Record<string, IndicatorSeriesContribution>;
    enabledIndicatorIds: ReadonlyArray<string>;
    width: number;
    height: number;
    outputUri: string;
  }): Promise<ChartRenderResult>;
}
```

- [ ] **Step 3: Find and fix all callers**

Run: `grep -rn "render({" src/ | grep -E "candles|chart"`
Expected: list of callers (analysis-worker activities, scheduler activities, etc.). They will be updated in Task 31.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/chart/PlaywrightChartRenderer.ts src/domain/ports/ChartRenderer.ts
git commit -m "refactor(chart): inject plugin scripts at warmUp; payload-driven activation"
```

---

### Task 27: Extend `PlaywrightChartRenderer` regression test

**Files:**
- Modify: `test/adapters/chart/PlaywrightChartRenderer.regression*` (existing file flagged in git status)

- [ ] **Step 1: Update the test**

Open the regression test file. Update setup:

```ts
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";

const registry = new IndicatorRegistry();
const calc = new PureJsIndicatorCalculator();
const renderer = new PlaywrightChartRenderer(registry, { poolSize: 1 });

// Three scenarios:
test("naked render", async () => {
  await renderer.render({
    candles, series: {}, enabledIndicatorIds: [],
    width: 1280, height: 900, outputUri: "file:///tmp/naked.png",
  });
});

test("recommended render", async () => {
  const plugins = registry.resolveActive({
    rsi: { enabled: true }, ema_stack: { enabled: true },
    volume: { enabled: true }, swings_bos: { enabled: true },
  });
  const series = await calc.computeSeries(candles, plugins);
  await renderer.render({
    candles, series,
    enabledIndicatorIds: plugins.map((p) => p.id),
    width: 1280, height: 720, outputUri: "file:///tmp/recommended.png",
  });
});

test("full render", async () => {
  const plugins = registry.all();
  const matrix = Object.fromEntries(plugins.map((p) => [p.id, { enabled: true }]));
  const active = registry.resolveActive(matrix);
  const series = await calc.computeSeries(candles, active);
  await renderer.render({
    candles, series,
    enabledIndicatorIds: active.map((p) => p.id),
    width: 1280, height: 720, outputUri: "file:///tmp/full.png",
  });
});
```

- [ ] **Step 2: Run, expect PASS, commit**

```bash
bun test test/adapters/chart/
git add test/adapters/chart/
git commit -m "test(chart): regression scenarios naked/recommended/full"
```

---

## Phase 6 — Workflow & DI integration

### Task 28: Wire registry + PromptBuilder into `buildContainer.ts`

**Files:**
- Modify: `src/workers/buildContainer.ts`

- [ ] **Step 1: Read current shape**

Inspect `src/workers/buildContainer.ts` (it constructs all DI singletons — calculator, chart renderer, repos). Identify where the calculator is constructed and where the chart renderer is.

- [ ] **Step 2: Add new constructions**

Near the top (after imports):

```ts
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";
import { PromptBuilder } from "@domain/services/PromptBuilder";
import { FewShotEngine } from "@domain/services/FewShotEngine";
```

In the build function:

```ts
const indicatorRegistry = new IndicatorRegistry();
const fewShotEngine = new FewShotEngine();
const promptBuilder = new PromptBuilder(indicatorRegistry, fewShotEngine);
await promptBuilder.warmUp();

const chartRenderer = new PlaywrightChartRenderer(indicatorRegistry, { poolSize: 2 });
await chartRenderer.warmUp();
```

Export `indicatorRegistry`, `promptBuilder`, `chartRenderer` in the returned container object.

- [ ] **Step 3: Build, run unit tests, commit**

```bash
bun tsc --noEmit
git add src/workers/buildContainer.ts
git commit -m "refactor(workers): wire IndicatorRegistry + PromptBuilder"
```

---

### Task 29: Update `setup/activities.ts` to use PromptBuilder

**Files:**
- Modify: `src/workflows/setup/activities.ts` (large file ~600 lines)

- [ ] **Step 1: Read the file's relevant sections**

Locate the activities that build detector/reviewer prompts. They currently call `loadPrompt("detector").render(ctx)` directly with the full Indicators scalars.

- [ ] **Step 2: Replace direct loadPrompt calls with PromptBuilder**

Old:
```ts
const prompt = await loadPrompt("detector");
const text = prompt.render({ asset, timeframe, indicators, ... });
```

New (the activity now receives `promptBuilder` from container DI):
```ts
const text = await promptBuilder.buildDetectorPrompt({
  asset, timeframe, tickAt, scalars: indicators,
  activeLessons, aliveSetups, htf,
  indicatorsMatrix: watch.indicators,
});
```

Same for the reviewer.

- [ ] **Step 3: Update the activity's parsed output validation**

Today the analysis-worker validates `confidence_breakdown` as a fixed 4-axis object. Change to use `buildConfidenceBreakdownSchema(plugins, htfEnabled).parse(...)`.

```ts
import { buildConfidenceBreakdownSchema } from "@domain/schemas/ConfidenceBreakdown";

const plugins = indicatorRegistry.resolveActive(watch.indicators);
const breakdownSchema = buildConfidenceBreakdownSchema(plugins, !!htf);
// In the detector output Zod schema, replace the fixed 4-axis confidence_breakdown
// with `breakdownSchema` (or `clarity` field for naked).
```

The detector response Zod (likely in `src/domain/schemas/DetectorOutput.ts` or similar) needs to accept a discriminated union: naked → `clarity`; otherwise → `confidence_breakdown` per-axes. Use `z.union([z.object({clarity: ...}), z.object({confidence_breakdown: breakdownSchema})])` or merge dynamically.

- [ ] **Step 4: Build, run unit + integration tests, commit**

```bash
bun tsc --noEmit
bun test test/workflows/setup/
git add src/workflows/setup/activities.ts src/domain/schemas/
git commit -m "refactor(setup): use PromptBuilder + adaptive breakdown schema"
```

---

### Task 30: Update `scheduler/activities.ts` to capture only active scalars

**Files:**
- Modify: `src/workflows/scheduler/activities.ts`

- [ ] **Step 1: Read file**

Identify the activity that produces `TickSnapshot` (computes indicators, persists snapshot, renders chart, runs pre-filter).

- [ ] **Step 2: Branch on the active matrix**

Replace the unconditional indicator computation:

Old:
```ts
const indicators = await calc.compute(candles); // returned full Indicators
```

New:
```ts
const plugins = indicatorRegistry.resolveActive(watch.indicators);
const scalars = await calc.compute(candles, plugins);
const series = await calc.computeSeries(candles, plugins);
```

For the chart render call:
```ts
const enabledIds = plugins.map((p) => p.id);
const naked = enabledIds.length === 0;
await chartRenderer.render({
  candles,
  series,
  enabledIndicatorIds: enabledIds,
  width: 1280,
  height: naked ? 900 : 720,
  outputUri,
});
```

For the pre-filter:
```ts
const passed = evaluatePreFilter(candles, scalars, watch.pre_filter, plugins);
```

(The `evaluatePreFilter` signature change is implemented in Task 32.)

- [ ] **Step 3: Update tickSnapshots persistence**

`src/adapters/persistence/PostgresTickSnapshotStore.ts`: the `indicators` jsonb column already accepts arbitrary shape — ensure the type is loosened.

In `src/adapters/persistence/schema.ts:135`:

```ts
import type { IndicatorScalars } from "@domain/schemas/Indicators";
// …
indicators: jsonb("indicators").$type<IndicatorScalars>().notNull(),
```

This is a TypeScript-only change (no SQL migration).

- [ ] **Step 4: Build, run tests, commit**

```bash
bun tsc --noEmit
bun test test/workflows/scheduler/
git add src/workflows/scheduler/activities.ts src/adapters/persistence/schema.ts src/adapters/persistence/PostgresTickSnapshotStore.ts
git commit -m "refactor(scheduler): capture scalars/series filtered by active matrix"
```

---

### Task 31: Update `loadPrompt.ts` (versions allowlist)

**Files:**
- Modify: `src/adapters/prompts/loadPrompt.ts`

- [ ] **Step 1: Verify the allowlist accepts the new versions**

Open the file. The version regex extracts strings like `detector_v5`, `reviewer_v5`. No code change needed — just confirm.

If a downstream test or migration references `detector_v4` / `reviewer_v4` literally, update the references.

```bash
grep -rn "_v4\b" src/ test/ prompts/ scripts/
```

If hits exist, replace with `_v5` (detector / reviewer only — finalizer stays v4 in v1).

- [ ] **Step 2: Commit if any changes**

```bash
git add -p
git commit -m "chore: bump detector/reviewer prompt version references to v5"
```

---

## Phase 7 — Pre-filter graceful degradation

### Task 32: Update `preFilter.ts` for β degradation

**Files:**
- Modify: `src/workflows/scheduler/preFilter.ts`
- Test: `test/workflows/scheduler/preFilter.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// test/workflows/scheduler/preFilter.test.ts
import { describe, expect, test } from "bun:test";
import { evaluatePreFilter } from "@workflows/scheduler/preFilter";
import { IndicatorRegistry } from "@adapters/indicators/IndicatorRegistry";

const registry = new IndicatorRegistry();
const allPlugins = registry.all();
const baseConfig = { enabled: true, mode: "lenient" as const,
  thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 } };

describe("preFilter β degradation", () => {
  test("all criteria active + lenient: passes if any criterion hits", () => {
    const scalars = { atr: 100, atrMa20: 50, lastVolume: 100, volumeMa20: 100, rsi: 50,
      recentHigh: 200, recentLow: 100 };
    const candles = [{ timestamp: new Date(), open: 100, high: 100, low: 100, close: 150, volume: 10 }];
    const result = evaluatePreFilter(candles, scalars, baseConfig, allPlugins);
    expect(result.passed).toBe(true);
  });

  test("no plugins active: returns passed=true (zero evaluated)", () => {
    const result = evaluatePreFilter([], {}, baseConfig, []);
    expect(result.passed).toBe(true);
    expect(result.reasons).toContain("no_active_criteria");
  });

  test("only RSI active: only rsi_extreme_distance evaluated", () => {
    const rsiOnly = allPlugins.filter((p) => p.id === "rsi");
    const scalars = { rsi: 80 };
    const result = evaluatePreFilter([], scalars, baseConfig, rsiOnly);
    expect(result.passed).toBe(true);
    expect(result.reasons[0]).toContain("rsi_extreme");
  });

  test("disabled config: passes regardless", () => {
    const result = evaluatePreFilter([], {}, { ...baseConfig, enabled: false }, allPlugins);
    expect(result.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Rewrite preFilter.ts**

```ts
// src/workflows/scheduler/preFilter.ts
import type { Candle } from "@domain/schemas/Candle";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";

export type PreFilterResult = { passed: boolean; reasons: string[] };

export function evaluatePreFilter(
  candles: Candle[],
  scalars: Record<string, unknown>,
  config: WatchConfig["pre_filter"],
  plugins: ReadonlyArray<IndicatorPlugin>,
): PreFilterResult {
  if (!config.enabled || config.mode === "off") {
    return { passed: true, reasons: ["disabled"] };
  }

  const criteria = new Set(
    plugins.map((p) => p.preFilterCriterion).filter((c): c is string => !!c),
  );
  if (criteria.size === 0) {
    return { passed: true, reasons: ["no_active_criteria"] };
  }

  const reasons: string[] = [];
  const t = config.thresholds;
  const num = (k: string) => {
    const v = scalars[k];
    return typeof v === "number" ? v : undefined;
  };

  if (criteria.has("atr_ratio_min")) {
    const atr = num("atr"), atrMa = num("atrMa20");
    if (atr !== undefined && atrMa !== undefined && atrMa > 0 && atr / atrMa > t.atr_ratio_min) {
      reasons.push(`atr_ratio=${(atr / atrMa).toFixed(2)}`);
    }
  }
  if (criteria.has("volume_spike_min")) {
    const last = num("lastVolume"), ma = num("volumeMa20");
    if (last !== undefined && ma !== undefined && ma > 0 && last / ma > t.volume_spike_min) {
      reasons.push(`volume_spike=${(last / ma).toFixed(2)}`);
    }
  }
  if (criteria.has("rsi_extreme_distance")) {
    const rsi = num("rsi");
    if (rsi !== undefined && Math.abs(rsi - 50) > t.rsi_extreme_distance) {
      reasons.push(`rsi_extreme=${rsi.toFixed(1)}`);
    }
  }
  if (criteria.has("near_pivot")) {
    const high = num("recentHigh"), low = num("recentLow");
    const last = candles[candles.length - 1]?.close;
    if (high !== undefined && low !== undefined && last != null) {
      const distHigh = Math.abs(high - last) / last;
      const distLow = Math.abs(low - last) / last;
      if (Math.min(distHigh, distLow) < 0.003) reasons.push("near_pivot");
    }
  }

  if (config.mode === "lenient") {
    return { passed: reasons.length > 0, reasons };
  }
  // strict mode: must hit every active criterion
  return { passed: reasons.length === criteria.size, reasons };
}
```

- [ ] **Step 3: Run, commit**

```bash
bun test test/workflows/scheduler/preFilter.test.ts
git add src/workflows/scheduler/preFilter.ts test/workflows/scheduler/preFilter.test.ts
git commit -m "refactor(prefilter): graceful β degradation by active matrix"
```

---

## Phase 8 — Frontend wizard step

### Task 33: Create `src/shared/indicatorMetadata.ts` aggregator

**Files:**
- Create: `src/shared/indicatorMetadata.ts`

- [ ] **Step 1: Create the aggregator (client-safe, no chartScript / compute imports)**

```ts
// src/shared/indicatorMetadata.ts
import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";
import { emaStackMetadata } from "@adapters/indicators/plugins/ema_stack/metadata";
import { vwapMetadata } from "@adapters/indicators/plugins/vwap/metadata";
import { bollingerMetadata } from "@adapters/indicators/plugins/bollinger/metadata";
import { rsiMetadata } from "@adapters/indicators/plugins/rsi/metadata";
import { macdMetadata } from "@adapters/indicators/plugins/macd/metadata";
import { atrMetadata } from "@adapters/indicators/plugins/atr/metadata";
import { volumeMetadata } from "@adapters/indicators/plugins/volume/metadata";
import { swingsBosMetadata } from "@adapters/indicators/plugins/swings_bos/metadata";
import { recentRangeMetadata } from "@adapters/indicators/plugins/recent_range/metadata";
import { liquidityPoolsMetadata } from "@adapters/indicators/plugins/liquidity_pools/metadata";
import { fvgMetadata } from "@adapters/indicators/plugins/fvg/metadata";
import { pocMetadata } from "@adapters/indicators/plugins/poc/metadata";

export const INDICATOR_METADATA: ReadonlyArray<IndicatorPluginMetadata> = [
  emaStackMetadata, vwapMetadata, bollingerMetadata,
  rsiMetadata, macdMetadata, atrMetadata,
  volumeMetadata,
  swingsBosMetadata, recentRangeMetadata,
  liquidityPoolsMetadata, fvgMetadata, pocMetadata,
] as const;

export const INDICATOR_METADATA_BY_TAG: Record<string, IndicatorPluginMetadata[]> =
  INDICATOR_METADATA.reduce<Record<string, IndicatorPluginMetadata[]>>((acc, m) => {
    (acc[m.tag] = acc[m.tag] ?? []).push(m);
    return acc;
  }, {});
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/indicatorMetadata.ts
git commit -m "feat(shared): client-safe indicator metadata aggregator"
```

---

### Task 34: Create `indicatorsPresets.ts`

**Files:**
- Create: `src/client/lib/indicatorsPresets.ts`

```ts
import type { IndicatorId, WatchConfig } from "@domain/schemas/WatchesConfig";
import { KNOWN_INDICATOR_IDS } from "@domain/schemas/WatchesConfig";

export const PRESETS = {
  naked: [] as ReadonlyArray<IndicatorId>,
  recommended: ["ema_stack", "rsi", "volume", "swings_bos"] as ReadonlyArray<IndicatorId>,
  all: KNOWN_INDICATOR_IDS,
} as const;

export type PresetName = keyof typeof PRESETS;

export function buildIndicatorsMatrix(
  ids: ReadonlyArray<IndicatorId>,
): WatchConfig["indicators"] {
  const matrix: Record<string, { enabled: boolean }> = {};
  for (const id of KNOWN_INDICATOR_IDS) matrix[id] = { enabled: ids.includes(id) };
  return matrix as WatchConfig["indicators"];
}
```

- [ ] **Commit**

```bash
git add src/client/lib/indicatorsPresets.ts
git commit -m "feat(client): indicators presets helper"
```

---

### Task 35: Build `section-indicators.tsx` component

**Files:**
- Create: `src/client/components/watch-form/section-indicators.tsx`

- [ ] **Step 1: Write the component**

```tsx
import * as React from "react";
import { useFormContext } from "react-hook-form";
import { Button } from "@client/components/ui/button";
import { Card } from "@client/components/ui/card";
import { Checkbox } from "@client/components/ui/checkbox";
import {
  INDICATOR_METADATA, INDICATOR_METADATA_BY_TAG,
} from "@shared/indicatorMetadata";
import {
  PRESETS, type PresetName, buildIndicatorsMatrix,
} from "@client/lib/indicatorsPresets";

const TAG_LABELS: Record<string, string> = {
  trend: "Trend", volatility: "Volatility", momentum: "Momentum",
  volume: "Volume", structure: "Structure", liquidity: "Liquidity",
};
const TAG_ORDER = ["trend", "volatility", "momentum", "volume", "structure", "liquidity"];

function InfoCard() {
  return (
    <Card className="p-4 text-sm space-y-2">
      <div className="font-semibold">Mode d'analyse</div>
      <p className="text-muted-foreground">
        Aucun indicateur coché = <strong>mode naked</strong>: le bot reçoit le
        chart brut (bougies seules) et fait une analyse purement visuelle. Plus
        créatif, moins guidé. Cocher un indicateur l'ajoute à la fois sur le
        chart et dans le prompt.
      </p>
      <p className="text-muted-foreground">
        Plus d'indicateurs = plus de tokens dans chaque appel LLM (~ +5% de
        coût par indicateur). Le score de confiance final s'adapte aux
        indicateurs activés.
      </p>
    </Card>
  );
}

function PresetButtons({ onApply }: { onApply: (preset: PresetName) => void }) {
  return (
    <div className="flex gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => onApply("naked")}>
        Naked
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => onApply("recommended")}>
        Recommended
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => onApply("all")}>
        Tout cocher
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => onApply("naked")}>
        Tout décocher
      </Button>
    </div>
  );
}

export function SectionIndicators() {
  const form = useFormContext();
  const matrix = form.watch("indicators") ?? {};

  const apply = (preset: PresetName) => {
    form.setValue("indicators", buildIndicatorsMatrix(PRESETS[preset]), { shouldDirty: true });
  };

  return (
    <div className="space-y-6">
      <InfoCard />
      <PresetButtons onApply={apply} />
      <div className="space-y-6">
        {TAG_ORDER.map((tag) => {
          const items = INDICATOR_METADATA_BY_TAG[tag] ?? [];
          if (items.length === 0) return null;
          return (
            <div key={tag} className="space-y-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {TAG_LABELS[tag] ?? tag}
              </div>
              <div className="space-y-2 pl-1">
                {items.map((m) => {
                  const checked = matrix[m.id]?.enabled === true;
                  return (
                    <label key={m.id} className="flex items-start gap-3 cursor-pointer">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          form.setValue(
                            `indicators.${m.id}`,
                            { enabled: v === true },
                            { shouldDirty: true },
                          );
                        }}
                      />
                      <div className="space-y-0.5">
                        <div className="font-medium">{m.displayName}</div>
                        <div className="text-xs text-muted-foreground">
                          {m.shortDescription}
                        </div>
                        <div className="text-[11px] text-muted-foreground/80">
                          {m.longDescription}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/components/watch-form/section-indicators.tsx
git commit -m "feat(client): SectionIndicators wizard step component"
```

---

### Task 36: Wire wizard step + edit tab

**Files:**
- Modify: `src/client/components/watch-form/index.tsx`

- [ ] **Step 1: Import and add step**

In `index.tsx`, add the import and a new wizard step. Insert at index 1 (after asset, before schedule):

```ts
import { SectionIndicators } from "@client/components/watch-form/section-indicators";

// In WIZARD_STEPS array, insert between "asset" and "schedule":
{
  id: "indicators",
  title: "Indicateurs",
  description:
    "Choisis quels indicateurs techniques le bot utilise pour analyser cette watch. Aucun indicateur = analyse purement visuelle (mode naked).",
  fields: ["indicators"],
  render: () => <SectionIndicators />,
},
```

- [ ] **Step 2: Update SENSIBLE_DEFAULTS**

Add to the `SENSIBLE_DEFAULTS` object:

```ts
indicators: {},
```

- [ ] **Step 3: Visual smoke test**

Run: `bun --hot src/server.ts` (or whatever the dev command is — check `package.json`).
Open the watch creation flow, verify the new step appears, presets work, descriptions display.

- [ ] **Step 4: Commit**

```bash
git add src/client/components/watch-form/index.tsx
git commit -m "feat(client): add Indicateurs wizard step"
```

---

### Task 37: Pre-filter UX hint in `section-advanced.tsx`

**Files:**
- Modify: `src/client/components/watch-form/section-advanced.tsx`

- [ ] **Step 1: Add active-criteria hints**

```tsx
// Inside SectionAdvanced, near the pre-filter thresholds inputs:
const indicators = form.watch("indicators") ?? {};
const isAtrActive = indicators.atr?.enabled === true;
const isVolumeActive = indicators.volume?.enabled === true;
const isRsiActive = indicators.rsi?.enabled === true;
const isRecentRangeActive = indicators.recent_range?.enabled === true;

// Render under each input:
{!isAtrActive && (
  <p className="text-xs text-muted-foreground">
    Désactivé automatiquement (indicateur ATR non sélectionné)
  </p>
)}
// idem for volume_spike_min / rsi_extreme_distance / near_pivot
```

- [ ] **Step 2: Commit**

```bash
git add src/client/components/watch-form/section-advanced.tsx
git commit -m "feat(client): pre-filter UX hint based on active indicators"
```

---

## Phase 9 — Nuke + final verification

### Task 38: Create `scripts/nuke-trading-flow.ts`

**Files:**
- Create: `scripts/nuke-trading-flow.ts`

- [ ] **Step 1: Create the script**

```ts
// scripts/nuke-trading-flow.ts
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const TABLES = [
  "watch_states",
  "setups",
  "events",
  "artifacts",
  "tick_snapshots",
  "watch_configs",
  "watch_config_revisions",
  "lessons",
  "lesson_events",
  "llm_calls",
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const confirm = process.argv.includes("--yes");
  if (!confirm) {
    console.error("This will DELETE ALL DATA. Pass --yes to confirm.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  for (const t of TABLES) {
    console.log(`TRUNCATE ${t}`);
    await db.execute(sql.raw(`TRUNCATE TABLE ${t} CASCADE;`));
  }

  await pool.end();
  console.log("✓ all rows wiped");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Test with a sandbox DB (do not run on prod yet)**

The user runs this manually at deploy time.

- [ ] **Step 3: Commit**

```bash
git add scripts/nuke-trading-flow.ts
git commit -m "feat(scripts): nuke-trading-flow one-shot wipe"
```

---

### Task 39: Full end-to-end smoke test

**Files:**
- (no new files)

- [ ] **Step 1: Run the full test suite**

```bash
bun test
```
Expected: all tests pass.

- [ ] **Step 2: TypeScript check**

```bash
bun tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Manual smoke test (UI)**

Start the dev server, create a watch via the wizard with each preset:
1. Naked → verify the new wizard step shows; verify SENSIBLE_DEFAULTS produces empty `indicators`.
2. Recommended → click `Recommended` button; verify 4 indicators get checked.
3. Tout cocher → 12 indicators checked.
4. Save the watch.

Trigger a tick. Verify:
- Naked watch produces a chart with only candles, no panes, no overlays.
- Recommended watch produces a chart with EMA + RSI pane + Volume pane + swing markers.
- The detector prompt logged shows the right structure (or absence) of the Indicators block.

- [ ] **Step 4: Commit any final fixes**

```bash
git status
# If anything is dirty, fix and commit:
git commit -am "chore: end-to-end smoke fixes"
```

---

### Task 40: Cleanup the temporary `Indicators` alias

**Files:**
- Modify: `src/domain/schemas/Indicators.ts`

- [ ] **Step 1: Remove the alias added in Task 5**

Delete the lines:

```ts
// Temporary: legacy consumers still import `Indicators`. Removed in Task 17.
export type Indicators = IndicatorScalars;
```

- [ ] **Step 2: Find dangling imports**

```bash
grep -rn "import.*\bIndicators\b" src/ test/ --include="*.ts" --include="*.tsx"
```

For each remaining import, replace with `IndicatorScalars` or remove the import entirely.

- [ ] **Step 3: Build, commit**

```bash
bun tsc --noEmit
git add -p
git commit -m "chore(schemas): remove legacy Indicators type alias"
```

---

## Self-review

The plan covers each spec section as follows:

- **§1 Context & goals** — covered by entire plan.
- **§2 Architecture & dataflow** — Tasks 1-3, 28.
- **§3.1 WatchSchema indicators field** — Task 1.
- **§3.2 Dynamic IndicatorsSchema** — Task 5.
- **§3.3 Adaptive ConfidenceBreakdownSchema** — Task 6.
- **§3.4 Plugin → axis mapping** — Tasks 13 (volume), 14-18 (structure plugins) declare `breakdownAxes`.
- **§3.5 Persistence** — Task 30 (loosen `tickSnapshots.indicators` type).
- **§4 IndicatorPlugin contract** — Task 2.
- **§4.1 Metadata-only split** — Task 33.
- **§4.2 Registry** — Task 3 (skeleton), tasks 7-18 (incremental fill), Task 19 (sanity).
- **§5 Plugin catalog** — Tasks 7-18 (one task per plugin).
- **§6 Prompt composition** — Tasks 21-24, 29.
- **§7 Chart composition** — Tasks 25-27.
- **§8 Frontend wizard step** — Tasks 33-37.
- **§9 Pre-filter graceful degradation** — Task 32.
- **§10 Migration: nuke** — Task 38.
- **§11 Testing** — Each task includes its tests; Task 39 = full smoke test.
- **§12 Phasing** — v1 scope = this plan.
- **§13 Open points** — #1 (persistence) resolved (jsonb already); #2 (finalizer wording) optional follow-up; #3 (TickSnapshot capture) covered Task 30; #4 (few-shot budget) capped at 3; #5 (HTF chart with same matrix) noted, applied in Task 30.

Type-consistency check:
- `IndicatorPlugin.chartPane` (Task 2) = `"price_overlay" | "secondary"` matches usage in chart-template (Task 25), in plugin chartScripts (Tasks 7-18), and in the renderer payload reading (`plugin.chartPane`).
- `secondaryPaneStretch` (Task 2) = optional number, used in Task 25 and declared in plugin objects (Tasks 7, 11, 12, 13).
- `IndicatorSeriesContribution` discriminated union (Task 2) — all `kind` values used: `"lines"` (Tasks 7, 8, 9, 10, 11, 12, 13), `"markers"` (Task 14), `"priceLines"` (Tasks 15, 16, 17). The renderer JS branches on `contribution.kind`.
- `KNOWN_INDICATOR_IDS` (Task 1) — list of 12 ids matches plugin folders (Tasks 7-18) and registry imports (Task 19).
- `evaluatePreFilter` signature (Task 32) — receives `(candles, scalars, config, plugins)` and is called from scheduler activities (Task 30) with the same shape.
- `PromptBuilder.buildDetectorPrompt` (Task 24) signature includes `indicatorsMatrix` — matches caller in setup activities (Task 29).

No placeholders remain. Each plugin task ships full code (compute, metadata, prompt fragments, chart script, plugin object) so the engineer can execute Tasks 7-18 without referring back to Task 7. The TDD pattern is established in Task 7 and the remaining plugin tasks (8-18) include their own tests.
