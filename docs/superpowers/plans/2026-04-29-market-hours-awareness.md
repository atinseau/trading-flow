# Market Hours Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop running LLM analyses (Detector / Reviewer / Finalizer / price tracking) when the market for the watched asset is closed, with automatic resumption at open.

**Architecture:** Hybrid Temporal-native pause/unpause for tick Schedules + intra-workflow guards for long-running workflows. Single source of truth in `domain/services/marketSession.ts` consumed by workflows AND frontend. One market-clock workflow per session (NASDAQ, Euronext, forex, …), N watches per session.

**Tech Stack:** Bun + TypeScript, Drizzle ORM, Temporal (`@temporalio/*`), React (Bun.serve HTML imports), Zod, `Intl.DateTimeFormat` for DST handling (no extra deps).

**Reference spec:** `docs/superpowers/specs/2026-04-29-market-hours-awareness-design.md` — read it for the "why" of every decision (D1–D10).

**Test runner:** `bun test` (per project CLAUDE.md). Tests live under `/test/` mirroring `/src/`.

---

## File structure

### New files

| Path | Responsibility |
|---|---|
| `src/domain/services/exchangeCalendars.ts` | Static data: `EXCHANGE_DEFS`, `FOREX_DEF`, `YAHOO_EXCHANGE_MAP`, `normalizeYahooExchange()` |
| `src/domain/services/marketSession.ts` | Pure functions: `getSession()`, `getSessionState()`, `watchesInSession()` |
| `src/domain/ports/WatchRepository.ts` | Port interface for reading watches |
| `src/domain/ports/ScheduleController.ts` | Port interface for Temporal Schedule pause/unpause |
| `src/adapters/persistence/PostgresWatchRepository.ts` | Drizzle-backed `WatchRepository` |
| `src/adapters/temporal/TemporalScheduleController.ts` | Temporal client-backed `ScheduleController` |
| `src/workflows/marketClock/marketClockWorkflow.ts` | Long-running orchestration per session |
| `src/workflows/marketClock/activities.ts` | Activities bridging ports → infra for the clock workflow |
| `src/workflows/marketClock/ensureMarketClock.ts` | Helper to start a clock if not running |
| `src/client/hooks/useMarketSession.ts` | React hook wrapping domain `getSessionState` with 60s refresh |
| `src/client/components/market-state-badge.tsx` | UI badge "Market closed · ouvre dans X" |
| `test/domain/services/marketSession.test.ts` | Unit tests for domain logic |
| `test/domain/services/exchangeCalendars.test.ts` | Unit tests for normalization |
| `test/adapters/persistence/PostgresWatchRepository.test.ts` | Repo tests |
| `test/workflows/marketClock/marketClockWorkflow.test.ts` | Temporal test framework integration test |

### Modified files

| Path | Change |
|---|---|
| `src/domain/schemas/WatchesConfig.ts` | Extend `asset` with `quoteType`, `exchange`; resserrer `source` enum; add invariants in `superRefine` |
| `src/domain/errors.ts` | Add `UnsupportedExchangeError` |
| `src/client/lib/marketData.ts` | Already returns `quoteType`/`exchange` — no change but verify shape |
| `src/client/components/watch-form/section-asset.tsx` (and any other component constructing the POST `/watches` payload) | Forward `quoteType` + `exchange` into the saved watch config |
| `src/workflows/setup/setupWorkflow.ts` | Add market-state guard before each loop iteration |
| `src/workflows/setup/trackingLoop.ts` | Add guard if applicable |
| `src/workflows/price-monitor/priceMonitorWorkflow.ts` | Filter `trackingPrice` emissions per setup by market state |
| `src/config/bootstrapWatch.ts` | Call `ensureMarketClock(session)` + immediate pause if closed at creation |
| `src/config/loadWatchesConfig.ts`, `src/cli/bootstrap-schedules.ts`, `src/cli/reload-config.ts` | Use new `WatchRepository` port |
| `src/workers/buildContainer.ts` | Wire new ports/adapters |
| `src/workers/scheduler-worker.ts` | Register `marketClockWorkflow` + activities, call `bootstrapMarketClocks()` |
| `src/client/components/watch-card.tsx`, watch detail page, asset detail page | Render `<MarketStateBadge>` |

---

# Phase 1 — Pure domain (PR 1)

Zero behavior change. Mergeable and shippable on its own.

## Task 1.1: `exchangeCalendars.ts` data + normalization

**Files:**
- Create: `src/domain/services/exchangeCalendars.ts`
- Test: `test/domain/services/exchangeCalendars.test.ts`

- [ ] **Step 1: Write failing tests for `normalizeYahooExchange`**

```ts
// test/domain/services/exchangeCalendars.test.ts
import { describe, expect, test } from "bun:test";
import { EXCHANGE_DEFS, normalizeYahooExchange } from "@domain/services/exchangeCalendars";

describe("normalizeYahooExchange", () => {
  test("maps NASDAQ codes (NMS, NCM, NGM) → NASDAQ", () => {
    expect(normalizeYahooExchange("NMS")).toBe("NASDAQ");
    expect(normalizeYahooExchange("NCM")).toBe("NASDAQ");
    expect(normalizeYahooExchange("NGM")).toBe("NASDAQ");
  });
  test("maps NYQ → NYSE", () => expect(normalizeYahooExchange("NYQ")).toBe("NYSE"));
  test("maps PAR → PAR", () => expect(normalizeYahooExchange("PAR")).toBe("PAR"));
  test("maps JPX → TSE", () => expect(normalizeYahooExchange("JPX")).toBe("TSE"));
  test("maps HKG → HKEX", () => expect(normalizeYahooExchange("HKG")).toBe("HKEX"));
  test("returns null for unknown code", () => expect(normalizeYahooExchange("XYZ")).toBeNull());
  test("returns null for undefined", () => expect(normalizeYahooExchange(undefined)).toBeNull());
});

describe("EXCHANGE_DEFS", () => {
  test("US exchanges share NY tz and 09:30–16:00 hours", () => {
    for (const id of ["NASDAQ", "NYSE", "AMEX", "ARCA"] as const) {
      expect(EXCHANGE_DEFS[id].tz).toBe("America/New_York");
      expect(EXCHANGE_DEFS[id].ranges).toEqual([{ open: "09:30", close: "16:00" }]);
    }
  });
  test("Tokyo has lunch break (two ranges)", () => {
    expect(EXCHANGE_DEFS.TSE.ranges).toEqual([
      { open: "09:00", close: "11:30" },
      { open: "12:30", close: "15:00" },
    ]);
  });
  test("HKEX has lunch break (two ranges)", () => {
    expect(EXCHANGE_DEFS.HKEX.ranges).toEqual([
      { open: "09:30", close: "12:00" },
      { open: "13:00", close: "16:00" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify FAIL**

```bash
bun test test/domain/services/exchangeCalendars.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `exchangeCalendars.ts`**

Use the full data table from spec §5 (`EXCHANGE_DEFS`, `FOREX_DEF`, `YAHOO_EXCHANGE_MAP`). Export:

```ts
export type ExchangeDef = {
  tz: string;
  ranges: Array<{ open: string; close: string }>;
  days: number[]; // 1=Mon..5=Fri (ISO weekday)
};

export const EXCHANGE_DEFS = { /* ... full table from spec §5 ... */ } as const;
export type ExchangeId = keyof typeof EXCHANGE_DEFS;

export const FOREX_DEF = {
  tz: "America/New_York",
  open: { weekday: 0 as const, hhmm: "17:00" },
  close: { weekday: 5 as const, hhmm: "17:00" },
};

const YAHOO_EXCHANGE_MAP: Record<string, ExchangeId> = {
  NMS: "NASDAQ", NCM: "NASDAQ", NGM: "NASDAQ",
  NYQ: "NYSE", ASE: "AMEX", PCX: "ARCA",
  PAR: "PAR", AMS: "AMS", BRU: "BRU", MIL: "MIL",
  LSE: "LSE", GER: "XETRA", FRA: "XETRA",
  EBS: "SIX", JPX: "TSE", HKG: "HKEX",
};

export function normalizeYahooExchange(code: string | undefined): ExchangeId | null {
  if (!code) return null;
  return YAHOO_EXCHANGE_MAP[code] ?? null;
}
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
bun test test/domain/services/exchangeCalendars.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/domain/services/exchangeCalendars.ts test/domain/services/exchangeCalendars.test.ts
git commit -m "feat(domain): add exchange calendars table + Yahoo code normalization"
```

---

## Task 1.2: `getSession` — pure routing function

**Files:**
- Create: `src/domain/services/marketSession.ts`
- Modify: `src/domain/errors.ts`
- Test: `test/domain/services/marketSession.test.ts`

- [ ] **Step 1: Add `UnsupportedExchangeError` in `errors.ts`**

```ts
// Append to src/domain/errors.ts
export class UnsupportedExchangeError extends Error {
  constructor(public readonly code: string | undefined) {
    super(`Exchange '${code ?? "<undefined>"}' not yet supported`);
    this.name = "UnsupportedExchangeError";
  }
}
```

- [ ] **Step 2: Write failing tests for `getSession`**

```ts
// test/domain/services/marketSession.test.ts
import { describe, expect, test } from "bun:test";
import { getSession } from "@domain/services/marketSession";
import { UnsupportedExchangeError } from "@domain/errors";

const baseWatch = (asset: object) => ({ asset } as any);

describe("getSession", () => {
  test("binance source → always-open", () => {
    expect(getSession(baseWatch({ source: "binance", symbol: "BTCUSDT" })))
      .toEqual({ kind: "always-open" });
  });
  test("yahoo CRYPTOCURRENCY → always-open", () => {
    expect(getSession(baseWatch({ source: "yahoo", symbol: "BTC-USD", quoteType: "CRYPTOCURRENCY" })))
      .toEqual({ kind: "always-open" });
  });
  test("yahoo FUTURE → always-open", () => {
    expect(getSession(baseWatch({ source: "yahoo", symbol: "ES=F", quoteType: "FUTURE" })))
      .toEqual({ kind: "always-open" });
  });
  test("yahoo CURRENCY → forex", () => {
    expect(getSession(baseWatch({ source: "yahoo", symbol: "EURUSD=X", quoteType: "CURRENCY" })))
      .toEqual({ kind: "forex" });
  });
  test("yahoo EQUITY NMS → exchange NASDAQ", () => {
    expect(getSession(baseWatch({ source: "yahoo", symbol: "AAPL", quoteType: "EQUITY", exchange: "NMS" })))
      .toEqual({ kind: "exchange", id: "NASDAQ" });
  });
  test("yahoo INDEX PAR → exchange PAR", () => {
    expect(getSession(baseWatch({ source: "yahoo", symbol: "^FCHI", quoteType: "INDEX", exchange: "PAR" })))
      .toEqual({ kind: "exchange", id: "PAR" });
  });
  test("yahoo EQUITY unknown exchange → throws UnsupportedExchangeError", () => {
    expect(() =>
      getSession(baseWatch({ source: "yahoo", symbol: "FOO", quoteType: "EQUITY", exchange: "XYZ" }))
    ).toThrow(UnsupportedExchangeError);
  });
});
```

- [ ] **Step 3: Run, expect FAIL (module missing)**

```bash
bun test test/domain/services/marketSession.test.ts
```

- [ ] **Step 4: Implement `getSession`**

```ts
// src/domain/services/marketSession.ts
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { UnsupportedExchangeError } from "@domain/errors";
import { normalizeYahooExchange, type ExchangeId } from "./exchangeCalendars";

export type Session =
  | { kind: "always-open" }
  | { kind: "exchange"; id: ExchangeId }
  | { kind: "forex" };

export function getSession(watch: WatchConfig): Session {
  if (watch.asset.source === "binance") return { kind: "always-open" };
  switch (watch.asset.quoteType) {
    case "CURRENCY":
      return { kind: "forex" };
    case "FUTURE":
    case "CRYPTOCURRENCY":
      return { kind: "always-open" };
    case "EQUITY":
    case "ETF":
    case "INDEX": {
      const id = normalizeYahooExchange(watch.asset.exchange);
      if (!id) throw new UnsupportedExchangeError(watch.asset.exchange);
      return { kind: "exchange", id };
    }
    default:
      throw new Error(`Unsupported quoteType: ${watch.asset.quoteType}`);
  }
}
```

- [ ] **Step 5: Run, expect PASS. Commit.**

```bash
bun test test/domain/services/marketSession.test.ts
git add src/domain/services/marketSession.ts src/domain/errors.ts test/domain/services/marketSession.test.ts
git commit -m "feat(domain): add getSession() routing watch → market session kind"
```

---

## Task 1.3: `getSessionState` — always-open

**Files:**
- Modify: `src/domain/services/marketSession.ts`
- Modify: `test/domain/services/marketSession.test.ts`

- [ ] **Step 1: Add failing test**

```ts
// Append to test/domain/services/marketSession.test.ts
import { getSessionState } from "@domain/services/marketSession";

describe("getSessionState — always-open", () => {
  test("isOpen always true, no nextOpenAt/nextCloseAt", () => {
    const state = getSessionState({ kind: "always-open" }, new Date("2026-04-29T12:00:00Z"));
    expect(state.isOpen).toBe(true);
    expect(state.nextOpenAt).toBeUndefined();
    expect(state.nextCloseAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `getSessionState` skeleton with always-open branch**

```ts
// Append to src/domain/services/marketSession.ts
export type SessionState = {
  isOpen: boolean;
  nextOpenAt?: Date;
  nextCloseAt?: Date;
};

export function getSessionState(session: Session, now: Date): SessionState {
  if (session.kind === "always-open") return { isOpen: true };
  if (session.kind === "exchange") return computeExchangeState(session.id, now);
  if (session.kind === "forex") return computeForexState(now);
  throw new Error(`Unsupported session kind`);
}

// Stubs (will be implemented in next tasks)
function computeExchangeState(_id: ExchangeId, _now: Date): SessionState {
  throw new Error("not implemented");
}
function computeForexState(_now: Date): SessionState {
  throw new Error("not implemented");
}
```

- [ ] **Step 4: Run, expect PASS for always-open. Commit.**

```bash
bun test test/domain/services/marketSession.test.ts
git add -u
git commit -m "feat(domain): add getSessionState() always-open branch"
```

---

## Task 1.4: `getSessionState` — exchange (single-range, multi-range, DST)

**Files:**
- Modify: `src/domain/services/marketSession.ts`
- Modify: `test/domain/services/marketSession.test.ts`

This is the densest task. The implementation must:

1. Use `Intl.DateTimeFormat({ timeZone: def.tz })` to extract local `weekday`, `HH:mm` for `now`.
2. Iterate ranges; if current local time falls within a range and weekday is in `def.days`, `isOpen=true` with `nextCloseAt` = end of current range expressed back as UTC `Date`.
3. Otherwise compute `nextOpenAt` by walking forward minute-by-minute through the next 7 days' opens (cheaper: jump to next valid open boundary directly).

Helper module suggestion (private, in same file):

```ts
function localPartsInTz(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    isoWeekday: ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as const)[parts.weekday as "Mon"],
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    yyyy: Number(parts.year), MM: Number(parts.month), dd: Number(parts.day),
  };
}

// Convert local wall-clock components in a tz back to UTC instant
function utcFromLocalInTz(yyyy: number, MM: number, dd: number, hh: number, mm: number, tz: string): Date {
  // Standard trick: format then parse with offset disambiguation
  const candidate = new Date(Date.UTC(yyyy, MM - 1, dd, hh, mm));
  const localized = localPartsInTz(candidate, tz);
  const drift = (localized.hh - hh) * 60 + (localized.mm - mm);
  return new Date(candidate.getTime() - drift * 60_000);
}
```

(`utcFromLocalInTz` handles DST automatically because the drift correction is computed on the actual `candidate` instant.)

- [ ] **Step 1: Write failing tests (DST + lunch break + weekend)**

```ts
// Append to test/domain/services/marketSession.test.ts
describe("getSessionState — exchange", () => {
  test("NASDAQ open Mon 14:35 UTC in winter (= 09:35 ET)", () => {
    const state = getSessionState({ kind: "exchange", id: "NASDAQ" }, new Date("2026-01-12T14:35:00Z"));
    expect(state.isOpen).toBe(true);
    expect(state.nextCloseAt).toEqual(new Date("2026-01-12T21:00:00Z")); // 16:00 ET = 21:00 UTC EST
  });

  test("NASDAQ open Mon 14:35 UTC in summer (= 10:35 EDT)", () => {
    const state = getSessionState({ kind: "exchange", id: "NASDAQ" }, new Date("2026-07-13T14:35:00Z"));
    expect(state.isOpen).toBe(true);
    expect(state.nextCloseAt).toEqual(new Date("2026-07-13T20:00:00Z")); // 16:00 ET = 20:00 UTC EDT
  });

  test("NASDAQ closed Saturday → next open Mon 09:30 ET", () => {
    const state = getSessionState({ kind: "exchange", id: "NASDAQ" }, new Date("2026-01-10T15:00:00Z")); // Sat
    expect(state.isOpen).toBe(false);
    expect(state.nextOpenAt).toEqual(new Date("2026-01-12T14:30:00Z")); // Mon 09:30 EST = 14:30 UTC
  });

  test("Tokyo at 11:45 JST → closed (lunch break), next open 12:30 JST", () => {
    // 11:45 JST Mon = 02:45 UTC Mon
    const state = getSessionState({ kind: "exchange", id: "TSE" }, new Date("2026-04-13T02:45:00Z"));
    expect(state.isOpen).toBe(false);
    expect(state.nextOpenAt).toEqual(new Date("2026-04-13T03:30:00Z")); // 12:30 JST = 03:30 UTC
  });

  test("Tokyo at 13:00 JST → open, nextCloseAt 15:00 JST", () => {
    const state = getSessionState({ kind: "exchange", id: "TSE" }, new Date("2026-04-13T04:00:00Z"));
    expect(state.isOpen).toBe(true);
    expect(state.nextCloseAt).toEqual(new Date("2026-04-13T06:00:00Z")); // 15:00 JST = 06:00 UTC
  });

  test("DST transition Sunday US (spring forward 2026-03-08)", () => {
    // Mon 2026-03-09 09:35 ET = 13:35 UTC EDT (after spring forward)
    const state = getSessionState({ kind: "exchange", id: "NYSE" }, new Date("2026-03-09T13:35:00Z"));
    expect(state.isOpen).toBe(true);
  });

  test("Friday 22:00 UTC NYSE → closed → next open Monday", () => {
    const state = getSessionState({ kind: "exchange", id: "NYSE" }, new Date("2026-01-09T22:00:00Z"));
    expect(state.isOpen).toBe(false);
    expect(state.nextOpenAt).toEqual(new Date("2026-01-12T14:30:00Z"));
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `computeExchangeState`**

```ts
// Replace stub in src/domain/services/marketSession.ts
import { EXCHANGE_DEFS, type ExchangeId } from "./exchangeCalendars";

function parseHHmm(s: string): { hh: number; mm: number } {
  const [hh, mm] = s.split(":").map(Number);
  return { hh, mm };
}

function computeExchangeState(id: ExchangeId, now: Date): SessionState {
  const def = EXCHANGE_DEFS[id];
  const local = localPartsInTz(now, def.tz);

  // Currently in a range?
  if (def.days.includes(local.isoWeekday)) {
    for (const range of def.ranges) {
      const open = parseHHmm(range.open);
      const close = parseHHmm(range.close);
      const minutesNow = local.hh * 60 + local.mm;
      const minutesOpen = open.hh * 60 + open.mm;
      const minutesClose = close.hh * 60 + close.mm;
      if (minutesNow >= minutesOpen && minutesNow < minutesClose) {
        return {
          isOpen: true,
          nextCloseAt: utcFromLocalInTz(local.yyyy, local.MM, local.dd, close.hh, close.mm, def.tz),
        };
      }
    }
  }

  // Find next open: walk forward up to 8 days
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 24 * 3600 * 1000);
    const probeLocal = localPartsInTz(probe, def.tz);
    if (!def.days.includes(probeLocal.isoWeekday)) continue;
    for (const range of def.ranges) {
      const open = parseHHmm(range.open);
      const candidate = utcFromLocalInTz(
        probeLocal.yyyy, probeLocal.MM, probeLocal.dd, open.hh, open.mm, def.tz,
      );
      if (candidate.getTime() > now.getTime()) {
        return { isOpen: false, nextOpenAt: candidate };
      }
    }
  }
  throw new Error(`No open in next 8 days for ${id} — bug`);
}
```

(Add `localPartsInTz` and `utcFromLocalInTz` helpers shown above the stub.)

- [ ] **Step 4: Run, expect PASS. Iterate on implementation if any test fails — commonly DST tests reveal off-by-one in `utcFromLocalInTz`. Commit.**

```bash
bun test test/domain/services/marketSession.test.ts
git add -u
git commit -m "feat(domain): exchange session state with multi-range and DST handling"
```

---

## Task 1.5: `getSessionState` — forex

**Files:**
- Modify: `src/domain/services/marketSession.ts`
- Modify: `test/domain/services/marketSession.test.ts`

- [ ] **Step 1: Failing tests**

```ts
describe("getSessionState — forex", () => {
  test("Tuesday 10:00 UTC → open", () => {
    const state = getSessionState({ kind: "forex" }, new Date("2026-04-14T10:00:00Z"));
    expect(state.isOpen).toBe(true);
  });
  test("Saturday 10:00 UTC → closed, next open Sunday 17:00 ET", () => {
    const state = getSessionState({ kind: "forex" }, new Date("2026-04-11T10:00:00Z"));
    expect(state.isOpen).toBe(false);
    // Sunday 17:00 EDT = 21:00 UTC (April → DST active)
    expect(state.nextOpenAt).toEqual(new Date("2026-04-12T21:00:00Z"));
  });
  test("Friday 22:00 UTC summer → closed (after 17:00 EDT close)", () => {
    const state = getSessionState({ kind: "forex" }, new Date("2026-04-10T22:00:00Z"));
    expect(state.isOpen).toBe(false);
  });
  test("Sunday 22:00 UTC winter → open (Sunday 17:00 EST = 22:00 UTC)", () => {
    const state = getSessionState({ kind: "forex" }, new Date("2026-01-11T22:30:00Z"));
    expect(state.isOpen).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `computeForexState`**

```ts
import { FOREX_DEF } from "./exchangeCalendars";

function computeForexState(now: Date): SessionState {
  const local = localPartsInTz(now, FOREX_DEF.tz);
  const open = parseHHmm(FOREX_DEF.open.hhmm);   // 17:00 ET
  const close = parseHHmm(FOREX_DEF.close.hhmm); // 17:00 ET

  // Convert ISO weekday (1=Mon..7=Sun) into a "minutes since Sunday 00:00 ET"
  const sundayMin = (d: typeof local) => ((d.isoWeekday % 7) * 24 * 60) + d.hh * 60 + d.mm;
  const minNow = sundayMin(local);
  const minOpen = (FOREX_DEF.open.weekday * 24 * 60) + open.hh * 60 + open.mm;   // Sun 17:00
  const minClose = (FOREX_DEF.close.weekday * 24 * 60) + close.hh * 60 + close.mm; // Fri 17:00

  if (minNow >= minOpen && minNow < minClose) {
    // Open. nextCloseAt = upcoming Friday 17:00 ET in UTC
    const daysToFri = (5 - local.isoWeekday + 7) % 7;
    const fri = new Date(now.getTime() + daysToFri * 24 * 3600 * 1000);
    const friLocal = localPartsInTz(fri, FOREX_DEF.tz);
    return {
      isOpen: true,
      nextCloseAt: utcFromLocalInTz(friLocal.yyyy, friLocal.MM, friLocal.dd, close.hh, close.mm, FOREX_DEF.tz),
    };
  }
  // Closed. nextOpenAt = upcoming Sunday 17:00 ET
  const daysToSun = (7 - local.isoWeekday) % 7;  // 7=Sun → 0
  const sun = new Date(now.getTime() + daysToSun * 24 * 3600 * 1000);
  const sunLocal = localPartsInTz(sun, FOREX_DEF.tz);
  let candidate = utcFromLocalInTz(sunLocal.yyyy, sunLocal.MM, sunLocal.dd, open.hh, open.mm, FOREX_DEF.tz);
  if (candidate.getTime() <= now.getTime()) {
    // Past today's Sunday 17:00 → next week's Sunday
    const next = new Date(sun.getTime() + 7 * 24 * 3600 * 1000);
    const nl = localPartsInTz(next, FOREX_DEF.tz);
    candidate = utcFromLocalInTz(nl.yyyy, nl.MM, nl.dd, open.hh, open.mm, FOREX_DEF.tz);
  }
  return { isOpen: false, nextOpenAt: candidate };
}
```

- [ ] **Step 4: Run, expect PASS. Commit.**

```bash
bun test test/domain/services/marketSession.test.ts
git add -u
git commit -m "feat(domain): forex session 24/5 with DST-aware NY anchor"
```

---

## Task 1.6: `watchesInSession` helper

**Files:**
- Modify: `src/domain/services/marketSession.ts`
- Modify: `test/domain/services/marketSession.test.ts`

- [ ] **Step 1: Failing tests**

```ts
describe("watchesInSession", () => {
  const w = (asset: object) => ({ id: Math.random().toString(), asset } as any);
  const aapl = w({ source: "yahoo", symbol: "AAPL", quoteType: "EQUITY", exchange: "NMS" });
  const cac = w({ source: "yahoo", symbol: "^FCHI", quoteType: "INDEX", exchange: "PAR" });
  const eurusd = w({ source: "yahoo", symbol: "EURUSD=X", quoteType: "CURRENCY" });
  const btc = w({ source: "binance", symbol: "BTCUSDT" });

  test("filters to NASDAQ session", () => {
    expect(watchesInSession([aapl, cac, eurusd, btc], { kind: "exchange", id: "NASDAQ" }))
      .toEqual([aapl]);
  });
  test("filters to forex", () => {
    expect(watchesInSession([aapl, cac, eurusd, btc], { kind: "forex" })).toEqual([eurusd]);
  });
  test("filters to always-open", () => {
    expect(watchesInSession([aapl, cac, eurusd, btc], { kind: "always-open" })).toEqual([btc]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```ts
export function watchesInSession(watches: WatchConfig[], target: Session): WatchConfig[] {
  return watches.filter(w => {
    try {
      const s = getSession(w);
      if (s.kind !== target.kind) return false;
      if (s.kind === "exchange" && target.kind === "exchange") return s.id === target.id;
      return true;
    } catch {
      return false; // invalid watch (unknown exchange) → not in any session
    }
  });
}

// Helper to compute a stable key for a session (used for clock workflow IDs)
export function sessionKey(s: Session): string {
  return s.kind === "exchange" ? `exchange-${s.id}` : s.kind;
}
```

- [ ] **Step 4: Run, expect PASS. Commit. End of PR 1.**

```bash
bun test test/domain/services/
git add -u
git commit -m "feat(domain): watchesInSession + sessionKey helpers"
```

**End of Phase 1.** Open PR 1: "feat(domain): market session pure logic" — zero behavior change yet.

---

# Phase 2 — Data model (PR 2)

## Task 2.1: Update `WatchSchema`

**Files:**
- Modify: `src/domain/schemas/WatchesConfig.ts:55`
- Modify/Create: `test/domain/schemas/WatchesConfig.test.ts`

- [ ] **Step 1: Add failing tests for new invariants**

```ts
import { describe, expect, test } from "bun:test";
import { WatchSchema } from "@domain/schemas/WatchesConfig";

const baseValid = {
  id: "test-id", enabled: true,
  asset: { symbol: "AAPL", source: "yahoo", quoteType: "EQUITY", exchange: "NMS" },
  timeframes: { primary: "1h", higher: [] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 100, reviewer_lookback: 100, reviewer_chart_window: 50 },
  setup_lifecycle: { ttl_candles: 10, score_initial: 50, score_threshold_finalizer: 70, score_threshold_dead: 30 },
  analyzers: {
    detector: { provider: "p", model: "m" },
    reviewer: { provider: "p", model: "m" },
    finalizer: { provider: "p", model: "m" },
  },
};

describe("WatchSchema asset invariants", () => {
  test("yahoo EQUITY without exchange → invalid", () => {
    const r = WatchSchema.safeParse({
      ...baseValid,
      asset: { symbol: "AAPL", source: "yahoo", quoteType: "EQUITY" },
    });
    expect(r.success).toBe(false);
  });
  test("yahoo EQUITY with exchange → valid", () => {
    const r = WatchSchema.safeParse(baseValid);
    expect(r.success).toBe(true);
  });
  test("yahoo CURRENCY without exchange → valid (forex global)", () => {
    const r = WatchSchema.safeParse({
      ...baseValid,
      asset: { symbol: "EURUSD=X", source: "yahoo", quoteType: "CURRENCY" },
    });
    expect(r.success).toBe(true);
  });
  test("yahoo without quoteType → invalid (forces recreation)", () => {
    const r = WatchSchema.safeParse({
      ...baseValid,
      asset: { symbol: "AAPL", source: "yahoo" },
    });
    expect(r.success).toBe(false);
  });
  test("binance without quoteType/exchange → valid", () => {
    const r = WatchSchema.safeParse({
      ...baseValid,
      asset: { symbol: "BTCUSDT", source: "binance" },
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Update the asset shape and add invariants**

```ts
// src/domain/schemas/WatchesConfig.ts
const QuoteTypeSchema = z.enum(["EQUITY", "ETF", "INDEX", "CURRENCY", "FUTURE", "CRYPTOCURRENCY"]);
const SourceSchema = z.enum(["binance", "yahoo"]);

const AssetSchema = z.object({
  symbol: z.string(),
  source: SourceSchema,
  quoteType: QuoteTypeSchema.optional(),
  exchange: z.string().optional(),
}).superRefine((asset, ctx) => {
  if (asset.source === "binance") return; // anything else ignored
  if (asset.source === "yahoo") {
    if (!asset.quoteType) {
      ctx.addIssue({ code: "custom", path: ["quoteType"], message: "yahoo asset requires quoteType (recreate watch)" });
      return;
    }
    if (["EQUITY", "ETF", "INDEX"].includes(asset.quoteType) && !asset.exchange) {
      ctx.addIssue({ code: "custom", path: ["exchange"], message: `${asset.quoteType} requires exchange` });
    }
  }
});

// In WatchSchema, replace the existing `asset:` line:
// asset: AssetSchema,
```

(`source: z.string()` was previously broad; the existing `superRefine` in `WatchesConfigSchema` already verifies sources match `market_data` — keep that. Just resserrer the inner enum.)

- [ ] **Step 4: Run, expect PASS. Commit.**

```bash
bun test test/domain/schemas/
git add -u
git commit -m "feat(schema): require quoteType + exchange on yahoo asset; resserrer source enum"
```

---

## Task 2.2: Frontend persists `quoteType` + `exchange`

**Files:**
- Read: `src/client/lib/marketData.ts:64-84` (verify shape)
- Modify: `src/client/components/watch-form/section-asset.tsx` (or wherever the watch creation payload is assembled)
- Modify: `src/client/api/watches.ts` (or equivalent)

- [ ] **Step 1: Inspect current creation flow**

```bash
grep -rn "quoteType\|asset.*source" src/client/components/watch-form src/client/api/watches.ts 2>/dev/null
```

Identify where the asset is selected and the watch payload built. Today the payload likely sets only `{ symbol, source }`.

- [ ] **Step 2: Modify selected asset state to include `quoteType` + `exchange`**

When the user picks an asset from the search results, store all four fields. The search result already exposes them (`marketData.ts:64-84`).

```tsx
// Pseudocode — adapt to actual component
const [selectedAsset, setSelectedAsset] = useState<{
  symbol: string;
  source: "binance" | "yahoo";
  quoteType?: string;
  exchange?: string;
} | null>(null);

// On asset pick:
setSelectedAsset({
  symbol: result.symbol,
  source: result.source,
  quoteType: result.quoteType,
  exchange: result.exchange,
});
```

- [ ] **Step 3: Include these fields in the POST `/watches` payload**

```ts
// In the createWatch call, build asset:
asset: {
  symbol: selectedAsset.symbol,
  source: selectedAsset.source,
  ...(selectedAsset.source === "yahoo" && {
    quoteType: selectedAsset.quoteType,
    exchange: selectedAsset.exchange,
  }),
}
```

- [ ] **Step 4: Manual smoke test**

```bash
bun --hot src/client/server.ts
```

Open the watch creation wizard, search "AAPL", select, create. Verify in DB:

```sql
SELECT id, config->'asset' FROM watch_configs ORDER BY created_at DESC LIMIT 1;
```

Expected: `{"symbol": "AAPL", "source": "yahoo", "quoteType": "EQUITY", "exchange": "NMS"}` (or similar Yahoo code).

- [ ] **Step 5: Commit. End of PR 2.**

```bash
git add -u
git commit -m "feat(tf-web): persist quoteType + exchange when creating yahoo-sourced watches"
```

---

# Phase 3 — Ports & adapters (PR 3)

## Task 3.1: `WatchRepository` port + Postgres impl

**Files:**
- Create: `src/domain/ports/WatchRepository.ts`
- Create: `src/adapters/persistence/PostgresWatchRepository.ts`
- Test: `test/adapters/persistence/PostgresWatchRepository.test.ts`

- [ ] **Step 1: Define port**

```ts
// src/domain/ports/WatchRepository.ts
import type { WatchConfig } from "@domain/schemas/WatchesConfig";

export type WatchValidationResult =
  | { id: string; raw: unknown; watch: WatchConfig; error?: never }
  | { id: string; raw: unknown; watch?: never; error: string };

export interface WatchRepository {
  findAll(): Promise<WatchConfig[]>;
  findById(id: string): Promise<WatchConfig | null>;
  findEnabled(): Promise<WatchConfig[]>;
  findAllWithValidation(): Promise<WatchValidationResult[]>;
}
```

- [ ] **Step 2: Failing test for Postgres impl**

```ts
// test/adapters/persistence/PostgresWatchRepository.test.ts
// Use existing test DB harness from /test/helpers/ (look at how PostgresSetupRepository tests are set up)
import { describe, expect, test, beforeEach } from "bun:test";
import { PostgresWatchRepository } from "@adapters/persistence/PostgresWatchRepository";
// ... setup helpers

describe("PostgresWatchRepository", () => {
  test("findEnabled returns only valid + enabled watches", async () => {
    // seed: one valid yahoo watch, one binance watch, one yahoo missing quoteType, one disabled
    // assert findEnabled returns 2
  });
  test("findAllWithValidation flags invalid watches with error", async () => {
    // assert the invalid yahoo row has { error: <validation message> }
  });
});
```

(Look at `test/adapters/persistence/PostgresSetupRepository.test.ts` for harness patterns.)

- [ ] **Step 3: Implement Postgres repo**

```ts
// src/adapters/persistence/PostgresWatchRepository.ts
import type { WatchRepository, WatchValidationResult } from "@domain/ports/WatchRepository";
import { WatchSchema, type WatchConfig } from "@domain/schemas/WatchesConfig";
import { watchConfigs } from "./schema";
import { eq, isNull, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export class PostgresWatchRepository implements WatchRepository {
  constructor(private db: NodePgDatabase) {}

  async findAll(): Promise<WatchConfig[]> {
    return (await this.findAllWithValidation())
      .filter((r): r is Extract<WatchValidationResult, { watch: WatchConfig }> => !!r.watch)
      .map(r => r.watch);
  }

  async findById(id: string): Promise<WatchConfig | null> {
    const rows = await this.db.select().from(watchConfigs)
      .where(and(eq(watchConfigs.id, id), isNull(watchConfigs.deletedAt)))
      .limit(1);
    if (!rows[0]) return null;
    const parsed = WatchSchema.safeParse(rows[0].config);
    return parsed.success ? parsed.data : null;
  }

  async findEnabled(): Promise<WatchConfig[]> {
    const all = await this.findAllWithValidation();
    return all
      .filter((r): r is Extract<WatchValidationResult, { watch: WatchConfig }> => !!r.watch && r.watch.enabled)
      .map(r => r.watch);
  }

  async findAllWithValidation(): Promise<WatchValidationResult[]> {
    const rows = await this.db.select().from(watchConfigs)
      .where(isNull(watchConfigs.deletedAt));
    return rows.map(row => {
      const parsed = WatchSchema.safeParse(row.config);
      return parsed.success
        ? { id: row.id, raw: row.config, watch: parsed.data }
        : { id: row.id, raw: row.config, error: parsed.error.issues.map(i => i.message).join("; ") };
    });
  }
}
```

- [ ] **Step 4: Run tests, expect PASS. Commit.**

```bash
bun test test/adapters/persistence/PostgresWatchRepository.test.ts
git add -u
git commit -m "feat(adapter): add WatchRepository port + Postgres impl with graceful validation"
```

---

## Task 3.2: `ScheduleController` port + Temporal impl

**Files:**
- Create: `src/domain/ports/ScheduleController.ts`
- Create: `src/adapters/temporal/TemporalScheduleController.ts` (create folder if absent)

- [ ] **Step 1: Define port**

```ts
// src/domain/ports/ScheduleController.ts
export interface ScheduleController {
  pause(scheduleId: string, reason: string): Promise<void>;
  unpause(scheduleId: string): Promise<void>;
}
```

- [ ] **Step 2: Implement Temporal adapter**

```ts
// src/adapters/temporal/TemporalScheduleController.ts
import type { Client } from "@temporalio/client";
import { ScheduleNotFoundError } from "@temporalio/client";
import type { ScheduleController } from "@domain/ports/ScheduleController";
import { getLogger } from "@observability/logger";

const log = getLogger({ component: "temporal-schedule-controller" });

export class TemporalScheduleController implements ScheduleController {
  constructor(private client: Client) {}

  async pause(id: string, reason: string): Promise<void> {
    try {
      await this.client.schedule.getHandle(id).pause(reason);
    } catch (e) {
      if (e instanceof ScheduleNotFoundError) {
        log.warn({ id }, "pause skipped: schedule not found");
        return;
      }
      throw e;
    }
  }

  async unpause(id: string): Promise<void> {
    try {
      await this.client.schedule.getHandle(id).unpause();
    } catch (e) {
      if (e instanceof ScheduleNotFoundError) {
        log.warn({ id }, "unpause skipped: schedule not found");
        return;
      }
      throw e;
    }
  }
}
```

- [ ] **Step 3: Commit (no separate unit tests — covered by integration tests in Task 5.2).**

```bash
git add src/domain/ports/ScheduleController.ts src/adapters/temporal/TemporalScheduleController.ts
git commit -m "feat(adapter): add ScheduleController port + Temporal impl with not-found handling"
```

---

## Task 3.3: Refactor existing direct DB access to use `WatchRepository`

**Files:**
- Modify: `src/config/loadWatchesConfig.ts`
- Modify: `src/cli/bootstrap-schedules.ts`
- Modify: `src/cli/reload-config.ts`

- [ ] **Step 1: Identify direct usages**

```bash
grep -rn "watchConfigs\|watch_configs" src/config src/cli --include="*.ts"
```

- [ ] **Step 2: Replace direct Drizzle queries with `WatchRepository.findAll()` / `findEnabled()`**

In each file, accept a `WatchRepository` parameter (or read from DI container). Replace direct `db.select().from(watchConfigs)...` with `repo.findEnabled()` (or `findAll()` depending on intent).

Existing tests under `test/config/loadWatchesFromDb.test.ts` should still pass with the refactored implementation. If they break, it's because they tested the implementation detail (Drizzle access) — update them to inject a fake `WatchRepository` from `test/fakes/`.

- [ ] **Step 3: Create fake WatchRepository for tests**

```ts
// test/fakes/FakeWatchRepository.ts
import type { WatchRepository, WatchValidationResult } from "@domain/ports/WatchRepository";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";

export class FakeWatchRepository implements WatchRepository {
  constructor(private watches: WatchConfig[] = []) {}
  async findAll() { return this.watches; }
  async findById(id: string) { return this.watches.find(w => w.id === id) ?? null; }
  async findEnabled() { return this.watches.filter(w => w.enabled); }
  async findAllWithValidation(): Promise<WatchValidationResult[]> {
    return this.watches.map(w => ({ id: w.id, raw: w, watch: w }));
  }
}
```

- [ ] **Step 4: Run all config tests, expect PASS. Commit.**

```bash
bun test test/config/
git add -u
git commit -m "refactor: route watch reads through WatchRepository port"
```

---

## Task 3.4: Wire ports in `buildContainer`

**Files:**
- Modify: `src/workers/buildContainer.ts`

- [ ] **Step 1: Read existing container shape**

```bash
grep -n "Repository\|Controller\|new " src/workers/buildContainer.ts | head -20
```

- [ ] **Step 2: Add `watchRepo` and `scheduleController` to container**

Follow the existing wiring pattern. Both depend on already-available `db` and `temporalClient`.

```ts
// In buildContainer return:
watchRepo: new PostgresWatchRepository(db),
scheduleController: new TemporalScheduleController(temporalClient),
```

- [ ] **Step 3: Smoke-test the worker boots**

```bash
bun src/workers/scheduler-worker.ts &
sleep 3
kill %1
```

Expected: no errors at boot. Commit. End of PR 3.

```bash
git add -u
git commit -m "feat(worker): wire WatchRepository + ScheduleController in container"
```

---

# Phase 4 — Guards in long-running workflows (PR 4)

This phase yields immediate LLM cost savings on alive setups.

## Task 4.1: `setupWorkflow` market-state guard

**Files:**
- Modify: `src/workflows/setup/setupWorkflow.ts`
- Modify: `src/workflows/setup/activities.ts` (add `getNow` activity if not already present)
- Test: `test/workflows/setup/setupWorkflow.test.ts` (or extend existing)

- [ ] **Step 1: Read current loop structure**

```bash
grep -n "while\|workflow.sleep\|condition" src/workflows/setup/setupWorkflow.ts
```

- [ ] **Step 2: Add `getNow` activity if needed**

```ts
// src/workflows/setup/activities.ts
export const makeSetupActivities = (deps: { clock: Clock; ... }) => ({
  ...existing,
  getNow: async () => deps.clock.now(),
});
```

- [ ] **Step 3: Insert guard at top of each loop iteration**

```ts
// At top of the main alive-setup loop in setupWorkflow.ts
import { getSession, getSessionState } from "@domain/services/marketSession";

const session = getSession(input.watch);  // or fetched once at workflow start

while (setup.isAlive) {
  const now = await getNow();
  const state = getSessionState(session, now);
  if (!state.isOpen && state.nextOpenAt) {
    await workflow.sleep(state.nextOpenAt.getTime() - now.getTime());
    continue;
  }
  // existing logic: Reviewer / Finalizer / Tracking
}
```

- [ ] **Step 4: Failing test (Temporal test environment)**

Use `@temporalio/testing` with a mocked `getNow` returning a closed-market timestamp. Verify the workflow calls `workflow.sleep` and resumes only after the mock clock advances past `nextOpenAt`. Pattern: see `test/integration/schedulerWorkflow.integration.test.ts`.

- [ ] **Step 5: Run, expect PASS. Commit.**

```bash
bun test test/workflows/setup/
git add -u
git commit -m "feat(workflow): guard setupWorkflow loop against closed-market hours"
```

---

## Task 4.2: `priceMonitorWorkflow` per-setup guard

**Files:**
- Modify: `src/workflows/price-monitor/priceMonitorWorkflow.ts`
- Modify: `src/workflows/price-monitor/activities.ts` (add `getNow` if absent)

- [ ] **Step 1: Read emission loop**

```bash
grep -n "signalSetup\|trackingPrice\|aliveSetups" src/workflows/price-monitor/priceMonitorWorkflow.ts
```

- [ ] **Step 2: Add per-setup guard before emission**

```ts
import { getSession, getSessionState } from "@domain/services/marketSession";

for (const setup of aliveSetups) {
  const state = getSessionState(getSession(setup.watch), now);
  if (!state.isOpen) continue;  // skip this setup, others continue
  signalSetup(setup.id, "trackingPrice", price);
}
```

The workflow does **not** sleep — only the emission is filtered. Other setups on always-open assets continue receiving prices.

- [ ] **Step 3: Test — fake setup with binance source emits, fake setup with closed-market US equity skips**

Add a test verifying the per-setup behavior. Same Temporal test framework pattern.

- [ ] **Step 4: Run, expect PASS. Commit. End of PR 4.**

```bash
bun test test/workflows/price-monitor/
git add -u
git commit -m "feat(workflow): filter trackingPrice emissions per-setup by market state"
```

---

# Phase 5 — Market-clock workflows (PR 5)

## Task 5.1: `marketClock/activities.ts`

**Files:**
- Create: `src/workflows/marketClock/activities.ts`

- [ ] **Step 1: Implement activities factory**

```ts
// src/workflows/marketClock/activities.ts
import type { Clock } from "@domain/ports/Clock";
import type { WatchRepository } from "@domain/ports/WatchRepository";
import type { ScheduleController } from "@domain/ports/ScheduleController";
import { watchesInSession, type Session } from "@domain/services/marketSession";

export const makeMarketClockActivities = (deps: {
  clock: Clock;
  watches: WatchRepository;
  schedules: ScheduleController;
}) => ({
  getNow: async () => deps.clock.now(),

  listWatchesInSession: async (session: Session) => {
    const all = await deps.watches.findEnabled();
    return watchesInSession(all, session).map(w => ({ id: w.id }));  // serializable
  },

  applyToSchedules: async (
    ids: string[],
    action: "pause" | "unpause",
    reason: string,
  ) => {
    for (const id of ids) {
      if (action === "pause") await deps.schedules.pause(id, reason);
      else await deps.schedules.unpause(id);
    }
  },
});

export type MarketClockActivities = ReturnType<typeof makeMarketClockActivities>;
```

- [ ] **Step 2: Commit**

```bash
git add src/workflows/marketClock/activities.ts
git commit -m "feat(workflow): marketClock activities bridging ports"
```

---

## Task 5.2: `marketClockWorkflow.ts`

**Files:**
- Create: `src/workflows/marketClock/marketClockWorkflow.ts`
- Test: `test/workflows/marketClock/marketClockWorkflow.test.ts`

- [ ] **Step 1: Implement workflow**

```ts
// src/workflows/marketClock/marketClockWorkflow.ts
import * as workflow from "@temporalio/workflow";
import type { Session } from "@domain/services/marketSession";
import { getSessionState } from "@domain/services/marketSession";
import type { MarketClockActivities } from "./activities";

const { getNow, listWatchesInSession, applyToSchedules } =
  workflow.proxyActivities<MarketClockActivities>({
    startToCloseTimeout: "1 minute",
  });

export function marketClockWorkflowId(session: Session): string {
  return session.kind === "exchange" ? `clock-exchange-${session.id}` : `clock-${session.kind}`;
}

export async function marketClockWorkflow(input: { session: Session }): Promise<void> {
  while (true) {
    const now = await getNow();
    const watches = await listWatchesInSession(input.session);
    if (watches.length === 0) return;  // last watch removed → terminate

    const state = getSessionState(input.session, now);
    const action = state.isOpen ? "unpause" : "pause";
    await applyToSchedules(
      watches.map(w => `tick-${w.id}`),
      action,
      `market clock transition (${input.session.kind})`,
    );

    const wakeAt = state.isOpen ? state.nextCloseAt! : state.nextOpenAt!;
    const sleepMs = Math.max(60_000, wakeAt.getTime() - now.getTime());  // floor at 60s for safety
    await workflow.sleep(sleepMs);
  }
}
```

- [ ] **Step 2: Integration test using Temporal test framework**

```ts
// test/workflows/marketClock/marketClockWorkflow.test.ts
// Pattern from test/integration/schedulerWorkflow.integration.test.ts
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { marketClockWorkflow } from "@workflows/marketClock/marketClockWorkflow";

describe("marketClockWorkflow", () => {
  test("pauses schedules when session is closed", async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const pauseCalls: string[] = [];
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test",
      workflowsPath: require.resolve("@workflows/marketClock/marketClockWorkflow"),
      activities: {
        getNow: async () => new Date("2026-01-10T22:00:00Z"),  // Sat, NYSE closed
        listWatchesInSession: async () => [{ id: "watch_aapl" }],
        applyToSchedules: async (ids: string[], action: string) => {
          if (action === "pause") pauseCalls.push(...ids);
        },
      },
    });
    await worker.runUntil(
      env.client.workflow.execute(marketClockWorkflow, {
        args: [{ session: { kind: "exchange", id: "NYSE" } }],
        taskQueue: "test",
        workflowId: "test-clock",
        workflowExecutionTimeout: "5 seconds",
      }).catch(() => {})  // swallow timeout — we just want first iteration's effect
    );
    expect(pauseCalls).toContain("tick-watch_aapl");
    await env.teardown();
  }, 30_000);

  test("terminates when no watches remain", async () => {
    // similar setup, listWatchesInSession returns [] → workflow returns cleanly
  });
});
```

- [ ] **Step 3: Run, expect PASS. Commit.**

```bash
bun test test/workflows/marketClock/
git add -u
git commit -m "feat(workflow): marketClockWorkflow with sleep-until-transition"
```

---

## Task 5.3: `ensureMarketClock` + `bootstrapMarketClocks` helpers

**Files:**
- Create: `src/workflows/marketClock/ensureMarketClock.ts`

- [ ] **Step 1: Implement helpers**

```ts
// src/workflows/marketClock/ensureMarketClock.ts
import type { Client } from "@temporalio/client";
import { WorkflowNotFoundError } from "@temporalio/client";
import { getSession, sessionKey, type Session } from "@domain/services/marketSession";
import type { WatchRepository } from "@domain/ports/WatchRepository";
import { marketClockWorkflowId, marketClockWorkflow } from "./marketClockWorkflow";

export async function ensureMarketClock(deps: {
  client: Client;
  taskQueue: string;
  session: Session;
}): Promise<void> {
  if (deps.session.kind === "always-open") return;
  const id = marketClockWorkflowId(deps.session);
  try {
    const handle = deps.client.workflow.getHandle(id);
    const desc = await handle.describe();
    if (desc.status.name === "RUNNING") return;
  } catch (e) {
    if (!(e instanceof WorkflowNotFoundError)) throw e;
  }
  await deps.client.workflow.start(marketClockWorkflow, {
    workflowId: id,
    taskQueue: deps.taskQueue,
    args: [{ session: deps.session }],
  });
}

export async function bootstrapMarketClocks(deps: {
  client: Client;
  taskQueue: string;
  watches: WatchRepository;
}): Promise<void> {
  const all = await deps.watches.findEnabled();
  const sessions = new Map<string, Session>();
  for (const w of all) {
    try {
      const s = getSession(w);
      if (s.kind !== "always-open") sessions.set(sessionKey(s), s);
    } catch { /* invalid watch — skip silently, surfaced via UI badge */ }
  }
  for (const session of sessions.values()) {
    await ensureMarketClock({ client: deps.client, taskQueue: deps.taskQueue, session });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/workflows/marketClock/ensureMarketClock.ts
git commit -m "feat(workflow): ensureMarketClock + bootstrapMarketClocks helpers"
```

---

## Task 5.4: Hook into `bootstrapWatch.ts`

**Files:**
- Modify: `src/config/bootstrapWatch.ts`

- [ ] **Step 1: Add post-creation hook**

```ts
// At end of bootstrapWatch, after the schedule create/update block:
import { getSession, getSessionState } from "@domain/services/marketSession";
import { ensureMarketClock } from "@workflows/marketClock/ensureMarketClock";
import type { ScheduleController } from "@domain/ports/ScheduleController";
import type { Clock } from "@domain/ports/Clock";

// Extend BootstrapDeps:
export type BootstrapDeps = {
  client: Client;
  taskQueues: TaskQueues;
  scheduleController: ScheduleController;
  clock: Clock;
};

// At end of bootstrapWatch():
const session = getSession(watch);
if (session.kind !== "always-open") {
  await ensureMarketClock({ client, taskQueue: taskQueues.scheduler, session });
  const state = getSessionState(session, await clock.now());
  if (!state.isOpen) {
    await scheduleController.pause(scheduleId, "market closed at watch creation");
    watchLog.info({ scheduleId }, "paused schedule because market is closed");
  }
}
```

- [ ] **Step 2: Update existing tests**

`test/config/bootstrapWatch.test.ts` likely uses a `BootstrapDeps` mock. Extend it with fakes for `Clock` and `ScheduleController`. Use `test/fakes/` patterns.

```ts
// Example fake
class FakeScheduleController implements ScheduleController {
  paused: Array<{ id: string; reason: string }> = [];
  unpaused: string[] = [];
  async pause(id: string, reason: string) { this.paused.push({ id, reason }); }
  async unpause(id: string) { this.unpaused.push(id); }
}
```

Add a test: when `bootstrapWatch` is called for a yahoo NASDAQ watch and the fake clock is set to a Saturday → assert `scheduleController.pause` was called with the schedule ID.

- [ ] **Step 3: Run, commit**

```bash
bun test test/config/bootstrapWatch.test.ts
git add -u
git commit -m "feat(bootstrap): start market clock + pause schedule when market closed at creation"
```

---

## Task 5.5: Worker registration

**Files:**
- Modify: `src/workers/scheduler-worker.ts`
- Modify: `src/workers/buildContainer.ts` (verify `clock` is exported)

- [ ] **Step 1: Register `marketClockWorkflow` and activities**

```ts
// In scheduler-worker.ts, when constructing the Worker:
import { marketClockWorkflow } from "@workflows/marketClock/marketClockWorkflow";
import { makeMarketClockActivities } from "@workflows/marketClock/activities";
import { bootstrapMarketClocks } from "@workflows/marketClock/ensureMarketClock";

const worker = await Worker.create({
  // ...
  workflowsPath: require.resolve("./workflows-bundle"),  // ensure marketClockWorkflow is in bundle
  activities: {
    ...existingActivities,
    ...makeMarketClockActivities({
      clock: container.clock,
      watches: container.watchRepo,
      schedules: container.scheduleController,
    }),
  },
});

// After worker started, before run():
await bootstrapMarketClocks({
  client: container.temporalClient,
  taskQueue: "scheduler",
  watches: container.watchRepo,
});
```

If a `workflows-bundle.ts` aggregator exists, add `export * from "@workflows/marketClock/marketClockWorkflow"` to it.

- [ ] **Step 2: Manual smoke**

```bash
docker-compose up -d temporal postgres
bun src/workers/scheduler-worker.ts &
sleep 5
# In Temporal Web UI (http://localhost:8233): verify a clock-exchange-NASDAQ workflow appears if a NASDAQ watch exists
kill %1
```

- [ ] **Step 3: Commit. End of PR 5.**

```bash
git add -u
git commit -m "feat(worker): register marketClockWorkflow + bootstrap clocks at scheduler-worker start"
```

---

# Phase 6 — Frontend (PR 6)

## Task 6.1: `useMarketSession` hook

**Files:**
- Create: `src/client/hooks/useMarketSession.ts`

- [ ] **Step 1: Implement hook**

```ts
// src/client/hooks/useMarketSession.ts
import { useEffect, useMemo, useState } from "react";
import { getSession, getSessionState } from "@domain/services/marketSession";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";

export function useMarketSession(watch: WatchConfig) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const session = useMemo(() => {
    try { return getSession(watch); } catch { return null; }
  }, [watch]);
  const state = useMemo(
    () => (session ? getSessionState(session, now) : null),
    [session, now],
  );
  return { session, state };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/hooks/useMarketSession.ts
git commit -m "feat(tf-web): useMarketSession hook with 60s refresh"
```

---

## Task 6.2: `<MarketStateBadge />` component + `formatRelativeOpening`

**Files:**
- Create: `src/client/components/market-state-badge.tsx`

- [ ] **Step 1: Implement component**

```tsx
// src/client/components/market-state-badge.tsx
import { Badge } from "@/components/ui/badge";  // adjust to actual UI lib path
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { useMarketSession } from "@/hooks/useMarketSession";

function formatRelativeOpening(target: Date, now = new Date()): string {
  const diffMs = target.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return `dans ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  if (diffH < 24) return `dans ${diffH}h${String(remMin).padStart(2, "0")}`;
  const sameWeek = (target.getTime() - now.getTime()) < 7 * 24 * 3600 * 1000;
  const dayName = target.toLocaleDateString("fr-FR", { weekday: "long" });
  const time = target.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (sameWeek) return `${dayName} à ${time}`;
  const dateStr = target.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  return `le ${dateStr} à ${time}`;
}

export function MarketStateBadge({ watch }: { watch: WatchConfig }) {
  const { session, state } = useMarketSession(watch);
  if (!session || !state) return null;
  if (session.kind === "always-open") return null;
  if (state.isOpen) return null;
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Market closed · ouvre {formatRelativeOpening(state.nextOpenAt!)}
    </Badge>
  );
}
```

- [ ] **Step 2: Smoke test in browser**

```bash
bun --hot src/client/server.ts
```

Open the watch list, find a NASDAQ watch outside US market hours → expect badge "Market closed · ouvre dans Xh".

- [ ] **Step 3: Commit**

```bash
git add src/client/components/market-state-badge.tsx
git commit -m "feat(tf-web): MarketStateBadge component with relative opening label"
```

---

## Task 6.3: Integrate badge into watch card, watch detail, asset detail

**Files:**
- Modify: `src/client/components/watch-card.tsx`
- Modify: watch detail page (find via `grep -rn "watch detail\|WatchDetail" src/client/routes`)
- Modify: asset detail page

- [ ] **Step 1: Inject `<MarketStateBadge>` next to existing `enabled` badge in watch-card**

```tsx
// In watch-card.tsx, near where the enabled badge renders:
import { MarketStateBadge } from "@/components/market-state-badge";

<div className="flex items-center gap-2">
  <Badge variant={watch.enabled ? "default" : "secondary"}>
    {watch.enabled ? "Active" : "Disabled"}
  </Badge>
  <MarketStateBadge watch={watch} />
</div>
```

- [ ] **Step 2: Add to watch detail page header**

Same pattern, in the page header.

- [ ] **Step 3: Add to asset detail page header**

The asset detail page may not have a `WatchConfig` directly — it has the asset metadata. Build a minimal pseudo-watch from the asset to feed the hook:

```tsx
const pseudoWatch = { asset: { symbol, source, quoteType, exchange } } as any;
<MarketStateBadge watch={pseudoWatch} />
```

This is acceptable because `getSession` only reads `asset.*`.

- [ ] **Step 4: Manual smoke test**

Browse all three locations, verify badge appears/disappears correctly across sessions.

- [ ] **Step 5: Commit. End of PR 6.**

```bash
git add -u
git commit -m "feat(tf-web): show MarketStateBadge on watch card, watch detail, asset detail"
```

---

# Self-review checklist

After all phases land:

- [ ] All 10 spec decisions (D1–D10) traced to a task — verified during plan write.
- [ ] No `TODO`, `TBD`, or "implement later" in the codebase.
- [ ] No watches with `quoteType` missing should pass through any code path other than the "Invalid config" UI badge.
- [ ] `bun test` passes end to end.
- [ ] Manual smoke: `docker-compose up -d`, create a NASDAQ watch, observe Temporal Web showing `clock-exchange-NASDAQ` and the watch's `tick-*` schedule getting paused at 22:00 Paris.
- [ ] Manual smoke: at the same time, a Binance watch keeps tirring its cron — never paused.
- [ ] Manual smoke: a forex watch is paused at vendredi 22:00 Paris and unpaused dim 22:00 Paris (or 23:00 selon DST).

# Out of scope (per spec §14)

These are explicitly **not** in this plan and will surface as follow-ups if needed:

- Holiday calendars per exchange
- Per-contract calendars for futures
- Auto-backfill of `quoteType` for legacy watches
- After-hours / pre-market US data
- Notification "Market opens in 5 min"
