# Standby Mode + Infra/Watches Config Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the monolithic `Config` into env-driven `InfraConfig` (always loaded) and yaml-driven `WatchesConfig` (optional). When `config/watches.yaml` is absent, all workers and `bootstrap-schedules` enter a clean **standby** state instead of crashing.

**Architecture:** Two new loader functions (`loadInfraConfig` from `process.env`, `loadWatchesConfig` from file). Five entry points (`bootstrap-schedules.ts`, `reload-config.ts`, three `*-worker.ts`) follow the same pattern: load infra (throws if missing), load watches (`null` → standby branch). `buildContainer` accepts `watches: WatchesConfig | null` and short-circuits to a "minimal-deps" container in standby. Two new notifier adapters (`ConsoleNotifier`, `MultiNotifier`) replace the old per-watch Telegram routing.

**Tech Stack:** TypeScript, Bun, Zod, `bun:test`, Drizzle, Temporal, Pino.

**Migration strategy:** Phase 1 adds new modules alongside old ones — the build stays green throughout. Phase 2 is a coordinated multi-file refactor: between the start of Task 9 and the end of Task 17 the TypeScript build is intentionally red (because consumers half-reference old shapes and half-reference new ones). At the end of Task 17 it compiles green again. Old modules (`loadConfig.ts`, the original `Config` schema, `expandEnvVars`) are deleted in Task 18, once nothing imports them.

**`Notifier` port stays generic:** `send({ chatId, text, parseMode?, images? }) → { messageId }` is unchanged — the port keeps `chatId` per call so we can later support multiple Telegram bots/chats without breaking the abstraction. Internally for this iteration we use a single env-driven chat: `TelegramNotifier` is constructed with just `{ token }`; activities pass `deps.infra.notifications.telegram.chat_id` to every `send` call. To make this possible, `ActivityDeps` gains an `infra: InfraConfig` field. The same Phase 2 task that wires this up also hoists `include_chart_image`, `include_reasoning`, and `notify_on` from the watch's `notifications` block to top-level on the watch, and drops `watch.notifications.telegram_chat_id` reads in the six setup activities.

---

## File map

**New files:**
- `src/config/InfraConfig.ts` — Zod schema + `loadInfraConfig()` reading `process.env`.
- `src/config/loadWatchesConfig.ts` — `loadWatchesConfig(path)` returning `WatchesConfig | null`.
- `src/domain/schemas/WatchesConfig.ts` — new Zod schema (replaces `Config` schema).
- `src/adapters/notify/ConsoleNotifier.ts` — `Notifier` port impl that logs.
- `src/adapters/notify/MultiNotifier.ts` — `Notifier` fan-out.
- `test/config/InfraConfig.test.ts`
- `test/config/loadWatchesConfig.test.ts`
- `test/domain/schemas/WatchesConfig.test.ts`
- `test/adapters/notify/ConsoleNotifier.test.ts`
- `test/adapters/notify/MultiNotifier.test.ts`
- `test/integration/standby-boot.test.ts` (smoke)

**Deleted files (end of plan):**
- `src/config/loadConfig.ts`
- `src/domain/schemas/Config.ts`
- `test/config/loadConfig.test.ts`
- `test/domain/schemas/Config.test.ts`

**Modified files:**
- `src/observability/healthServer.ts` — add `"standby"` to `HealthStatus`.
- `src/adapters/notify/TelegramNotifier.ts` — constructor `{ token }` only (chat is per-call, unchanged).
- `src/adapters/market-data/BinanceFetcher.ts` — base URL hardcoded.
- `src/adapters/market-data/YahooFinanceFetcher.ts` — user agent hardcoded.
- `src/adapters/llm/buildProviderRegistry.ts` — signature `(watches, infra, store)`.
- `src/workflows/setup/activities.ts` — six `notifier.send` calls source `chatId` from `deps.infra.notifications.telegram.chat_id` (instead of `watch.notifications.telegram_chat_id`); reads of `watch.notifications.{notify_on,include_chart_image,include_reasoning}` migrate to top-level on the watch.
- `src/workflows/activityDependencies.ts` — `Config` → `WatchesConfig` typing; **add** `infra: InfraConfig` field.
- `src/workers/buildContainer.ts` — signature `(infra, watches | null, role)`; populates `deps.infra`.
- `src/workers/scheduler-worker.ts` — load infra + watches, standby branch.
- `src/workers/analysis-worker.ts` — same pattern.
- `src/workers/notification-worker.ts` — same pattern.
- `src/cli/bootstrap-schedules.ts` — same pattern.
- `src/cli/reload-config.ts` — same pattern.
- `docker-compose.yml` — Postgres TCP healthcheck, drop `ANTHROPIC_API_KEY`, document new env vars.
- `.env.example` — refresh with all new env vars.
- `config/watches.yaml.example` — new shape, no `${...}` interpolation.
- Existing tests touching `TelegramNotifier`, `buildProviderRegistry`, fetchers, `Config` schema — adjusted as part of their refactor task. `notification/activities.ts` and `FakeNotifier` are **unchanged** (port is unchanged).

---

## Phase 1 — Foundation modules (no consumer breakage)

### Task 1: HealthServer adds `"standby"` status

**Files:**
- Modify: `src/observability/healthServer.ts`
- Test: `test/observability/healthServer.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `test/observability/healthServer.test.ts`:

```ts
test("HealthServer responds 200 with standby status and reason", async () => {
  server = new HealthServer("test-component", 0);
  server.start();
  server.setStatus("standby", { reason: "no watches.yaml" });
  const res = await fetch(`http://localhost:${server.actualPort}/health`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; metadata?: Record<string, unknown> };
  expect(body.status).toBe("standby");
  expect(body.metadata).toEqual({ reason: "no watches.yaml" });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/observability/healthServer.test.ts
```

Expected: type error or runtime error — `"standby"` not in `HealthStatus`.

- [ ] **Step 3: Extend the type**

In `src/observability/healthServer.ts`, change:

```ts
export type HealthStatus = "ok" | "degraded" | "down";
```

to:

```ts
export type HealthStatus = "ok" | "degraded" | "down" | "standby";
```

The HTTP code branch (`s.status === "down" ? 503 : 200`) already returns 200 for any non-`"down"` status, so no other change is needed.

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test test/observability/healthServer.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/observability/healthServer.ts test/observability/healthServer.test.ts
git commit -m "feat(health): add standby status (HTTP 200, payload exposes 'standby')"
```

---

### Task 2: Hardcode base URLs in `BinanceFetcher`

**Files:**
- Modify: `src/adapters/market-data/BinanceFetcher.ts`
- Test: `test/adapters/market-data/BinanceFetcher.test.ts`

- [ ] **Step 1: Read current file to identify the `baseUrl` constructor field**

```bash
rtk proxy cat src/adapters/market-data/BinanceFetcher.ts | head -40
```

The class today takes `{ baseUrl?: string }` in its constructor. Extract that to a top-of-file `const`.

- [ ] **Step 2: Write the failing test**

Append to `test/adapters/market-data/BinanceFetcher.test.ts`:

```ts
test("BinanceFetcher constructs with no args", () => {
  const fetcher = new BinanceFetcher();
  expect(fetcher).toBeDefined();
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test test/adapters/market-data/BinanceFetcher.test.ts
```

Expected: TypeScript error if constructor has required args. If the current ctor accepts an optional `{ baseUrl }`, the test passes immediately — in that case skip to Step 5.

- [ ] **Step 4: Hardcode the base URL**

Replace the constructor signature so it takes no args; declare `const BINANCE_BASE_URL = "https://api.binance.com";` at the top of the file. Use that constant instead of the previous `this.baseUrl`. Remove the `baseUrl` instance field.

- [ ] **Step 5: Update existing tests if they pass `{ baseUrl }`**

Search the test file for any `new BinanceFetcher({ baseUrl: ... })` and change to `new BinanceFetcher()`. Keep the existing assertion content.

- [ ] **Step 6: Run all fetcher tests**

```bash
bun test test/adapters/market-data/BinanceFetcher.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/market-data/BinanceFetcher.ts test/adapters/market-data/BinanceFetcher.test.ts
git commit -m "refactor(market-data): hardcode Binance base URL (no constructor args)"
```

---

### Task 3: Hardcode user agent in `YahooFinanceFetcher`

**Files:**
- Modify: `src/adapters/market-data/YahooFinanceFetcher.ts`
- Test: `test/adapters/market-data/YahooFinanceFetcher.test.ts`

- [ ] **Step 1: Identical strategy to Task 2**

Apply the same change: top-of-file `const YAHOO_USER_AGENT = "...";`, no-arg constructor, update test invocations.

- [ ] **Step 2: Write the failing test**

Append to `test/adapters/market-data/YahooFinanceFetcher.test.ts`:

```ts
test("YahooFinanceFetcher constructs with no args", () => {
  const fetcher = new YahooFinanceFetcher();
  expect(fetcher).toBeDefined();
});
```

- [ ] **Step 3: Run, refactor, run**

```bash
bun test test/adapters/market-data/YahooFinanceFetcher.test.ts
```

Implement, then re-run.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/market-data/YahooFinanceFetcher.ts test/adapters/market-data/YahooFinanceFetcher.test.ts
git commit -m "refactor(market-data): hardcode Yahoo user-agent (no constructor args)"
```

---

### Task 4: `InfraConfig` schema + loader

**Files:**
- Create: `src/config/InfraConfig.ts`
- Create: `test/config/InfraConfig.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/config/InfraConfig.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { InfraConfigError, loadInfraConfig } from "@config/InfraConfig";

const VARS = [
  "DATABASE_URL",
  "DATABASE_POOL_SIZE",
  "DATABASE_SSL",
  "TEMPORAL_ADDRESS",
  "TEMPORAL_NAMESPACE",
  "TEMPORAL_TASK_QUEUE_SCHEDULER",
  "TEMPORAL_TASK_QUEUE_ANALYSIS",
  "TEMPORAL_TASK_QUEUE_NOTIFICATIONS",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "OPENROUTER_API_KEY",
  "ARTIFACTS_BASE_DIR",
  "CLAUDE_WORKSPACE_DIR",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

function setRequired() {
  process.env.DATABASE_URL = "postgres://user:pass@host:5432/db";
  process.env.TEMPORAL_ADDRESS = "temporal:7233";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.TELEGRAM_CHAT_ID = "12345";
}

test("loadInfraConfig throws when DATABASE_URL is missing", () => {
  process.env.TEMPORAL_ADDRESS = "x";
  process.env.TELEGRAM_BOT_TOKEN = "x";
  process.env.TELEGRAM_CHAT_ID = "x";
  expect(() => loadInfraConfig()).toThrow(InfraConfigError);
  expect(() => loadInfraConfig()).toThrow(/DATABASE_URL/);
});

test("loadInfraConfig throws when TELEGRAM_CHAT_ID is missing", () => {
  process.env.DATABASE_URL = "x";
  process.env.TEMPORAL_ADDRESS = "x";
  process.env.TELEGRAM_BOT_TOKEN = "x";
  expect(() => loadInfraConfig()).toThrow(/TELEGRAM_CHAT_ID/);
});

test("loadInfraConfig applies defaults when only required vars are set", () => {
  setRequired();
  const cfg = loadInfraConfig();
  expect(cfg.database.url).toBe("postgres://user:pass@host:5432/db");
  expect(cfg.database.pool_size).toBe(10);
  expect(cfg.database.ssl).toBe(false);
  expect(cfg.temporal.address).toBe("temporal:7233");
  expect(cfg.temporal.namespace).toBe("default");
  expect(cfg.temporal.task_queues.scheduler).toBe("scheduler");
  expect(cfg.temporal.task_queues.analysis).toBe("analysis");
  expect(cfg.temporal.task_queues.notifications).toBe("notifications");
  expect(cfg.notifications.telegram.bot_token).toBe("bot-token");
  expect(cfg.notifications.telegram.chat_id).toBe("12345");
  expect(cfg.llm.openrouter_api_key).toBeNull();
  expect(cfg.artifacts.base_dir).toBe("/data/artifacts");
  expect(cfg.claude.workspace_dir).toBe("/data/claude-workspace");
});

test("loadInfraConfig parses DATABASE_POOL_SIZE as number and DATABASE_SSL as boolean", () => {
  setRequired();
  process.env.DATABASE_POOL_SIZE = "25";
  process.env.DATABASE_SSL = "true";
  const cfg = loadInfraConfig();
  expect(cfg.database.pool_size).toBe(25);
  expect(cfg.database.ssl).toBe(true);
});

test("loadInfraConfig throws on non-numeric DATABASE_POOL_SIZE", () => {
  setRequired();
  process.env.DATABASE_POOL_SIZE = "not-a-number";
  expect(() => loadInfraConfig()).toThrow(InfraConfigError);
});

test("loadInfraConfig accepts overrides for all optional vars", () => {
  setRequired();
  process.env.TEMPORAL_NAMESPACE = "trading";
  process.env.TEMPORAL_TASK_QUEUE_SCHEDULER = "sched-q";
  process.env.OPENROUTER_API_KEY = "or-key";
  process.env.ARTIFACTS_BASE_DIR = "/var/data/artifacts";
  process.env.CLAUDE_WORKSPACE_DIR = "/var/claude";
  const cfg = loadInfraConfig();
  expect(cfg.temporal.namespace).toBe("trading");
  expect(cfg.temporal.task_queues.scheduler).toBe("sched-q");
  expect(cfg.llm.openrouter_api_key).toBe("or-key");
  expect(cfg.artifacts.base_dir).toBe("/var/data/artifacts");
  expect(cfg.claude.workspace_dir).toBe("/var/claude");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/config/InfraConfig.test.ts
```

Expected: import error — `@config/InfraConfig` doesn't exist.

- [ ] **Step 3: Implement `src/config/InfraConfig.ts`**

```ts
import { z } from "zod";

export class InfraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraConfigError";
  }
}

const InfraConfigSchema = z.object({
  database: z.object({
    url: z.string().min(1),
    pool_size: z.number().int().positive(),
    ssl: z.boolean(),
  }),
  temporal: z.object({
    address: z.string().min(1),
    namespace: z.string().min(1),
    task_queues: z.object({
      scheduler: z.string().min(1),
      analysis: z.string().min(1),
      notifications: z.string().min(1),
    }),
  }),
  notifications: z.object({
    telegram: z.object({
      bot_token: z.string().min(1),
      chat_id: z.string().min(1),
    }),
  }),
  llm: z.object({
    openrouter_api_key: z.string().nullable(),
  }),
  artifacts: z.object({
    base_dir: z.string().min(1),
  }),
  claude: z.object({
    workspace_dir: z.string().min(1),
  }),
});

export type InfraConfig = z.infer<typeof InfraConfigSchema>;

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new InfraConfigError(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function nullable(name: string): string | null {
  const v = process.env[name];
  return v === undefined || v === "" ? null : v;
}

function parseInt10(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new InfraConfigError(
      `Invalid ${name}: expected positive integer, got "${raw}"`,
    );
  }
  return n;
}

function parseBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new InfraConfigError(
    `Invalid ${name}: expected "true"|"false"|"1"|"0", got "${raw}"`,
  );
}

export function loadInfraConfig(): InfraConfig {
  const raw = {
    database: {
      url: required("DATABASE_URL"),
      pool_size: parseInt10("DATABASE_POOL_SIZE", 10),
      ssl: parseBool("DATABASE_SSL", false),
    },
    temporal: {
      address: required("TEMPORAL_ADDRESS"),
      namespace: optional("TEMPORAL_NAMESPACE", "default"),
      task_queues: {
        scheduler: optional("TEMPORAL_TASK_QUEUE_SCHEDULER", "scheduler"),
        analysis: optional("TEMPORAL_TASK_QUEUE_ANALYSIS", "analysis"),
        notifications: optional("TEMPORAL_TASK_QUEUE_NOTIFICATIONS", "notifications"),
      },
    },
    notifications: {
      telegram: {
        bot_token: required("TELEGRAM_BOT_TOKEN"),
        chat_id: required("TELEGRAM_CHAT_ID"),
      },
    },
    llm: {
      openrouter_api_key: nullable("OPENROUTER_API_KEY"),
    },
    artifacts: {
      base_dir: optional("ARTIFACTS_BASE_DIR", "/data/artifacts"),
    },
    claude: {
      workspace_dir: optional("CLAUDE_WORKSPACE_DIR", "/data/claude-workspace"),
    },
  };

  const result = InfraConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new InfraConfigError(`InfraConfig validation failed:\n${issues}`);
  }
  return result.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test test/config/InfraConfig.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config/InfraConfig.ts test/config/InfraConfig.test.ts
git commit -m "feat(config): add InfraConfig schema + env-driven loader"
```

---

### Task 5: `WatchesConfig` schema (new file, parallel to old `Config`)

**Files:**
- Create: `src/domain/schemas/WatchesConfig.ts`
- Create: `test/domain/schemas/WatchesConfig.test.ts`

The new schema mirrors the spec section 3. The old `Config.ts` is left untouched in this task — it will be deleted in Task 16 once nothing imports it.

- [ ] **Step 1: Write the failing tests**

Create `test/domain/schemas/WatchesConfig.test.ts`:

```ts
import { expect, test } from "bun:test";
import { WatchesConfigSchema } from "@domain/schemas/WatchesConfig";

const minimalValid = {
  version: 1,
  market_data: ["binance"],
  llm_providers: {
    claude_max: { type: "claude-agent-sdk", fallback: null },
  },
  artifacts: { type: "filesystem" },
  watches: [
    {
      id: "btc-1h",
      asset: { symbol: "BTCUSDT", source: "binance" },
      timeframes: { primary: "1h", higher: [] },
      schedule: { detector_cron: "*/15 * * * *" },
      candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
      setup_lifecycle: {
        ttl_candles: 50,
        score_initial: 25,
        score_threshold_finalizer: 80,
        score_threshold_dead: 10,
        invalidation_policy: "strict",
      },
      analyzers: {
        detector: { provider: "claude_max", model: "x" },
        reviewer: { provider: "claude_max", model: "x" },
        finalizer: { provider: "claude_max", model: "x" },
      },
      notify_on: ["confirmed"],
    },
  ],
};

test("WatchesConfigSchema accepts minimal valid input", () => {
  const r = WatchesConfigSchema.safeParse(minimalValid);
  expect(r.success).toBe(true);
});

test("WatchesConfigSchema parses market_data as a string array", () => {
  const r = WatchesConfigSchema.safeParse(minimalValid);
  if (!r.success) throw new Error("expected success");
  expect(r.data.market_data).toEqual(["binance"]);
});

test("WatchesConfigSchema rejects watch.asset.source not in market_data", () => {
  const bad = structuredClone(minimalValid);
  bad.watches[0].asset.source = "kraken";
  const r = WatchesConfigSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test("WatchesConfigSchema defaults notifications.telegram to false when block absent", () => {
  const r = WatchesConfigSchema.safeParse(minimalValid);
  if (!r.success) throw new Error("expected success");
  expect(r.data.notifications.telegram).toBe(false);
});

test("WatchesConfigSchema accepts notifications.telegram = true", () => {
  const withTelegram = { ...minimalValid, notifications: { telegram: true } };
  const r = WatchesConfigSchema.safeParse(withTelegram);
  if (!r.success) throw new Error("expected success");
  expect(r.data.notifications.telegram).toBe(true);
});

test("WatchesConfigSchema rejects unknown llm provider in watch.analyzers", () => {
  const bad = structuredClone(minimalValid);
  bad.watches[0].analyzers.detector.provider = "openai";
  const r = WatchesConfigSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test("WatchesConfigSchema rejects duplicate watch IDs", () => {
  const bad = structuredClone(minimalValid);
  bad.watches.push(structuredClone(bad.watches[0]));
  const r = WatchesConfigSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test("WatchSchema no longer accepts notifications.telegram_chat_id (field removed)", () => {
  // Adding the old field should not appear in parsed output.
  const withOldField = structuredClone(minimalValid);
  // biome-ignore lint/suspicious/noExplicitAny: legacy-shape probe
  (withOldField.watches[0] as any).notifications = { telegram_chat_id: "x", notify_on: ["confirmed"] };
  const r = WatchesConfigSchema.safeParse(withOldField);
  // The new schema has notify_on at the top, so the inner notifications block is unexpected but
  // Zod by default strips unknown keys → still valid. The crucial assertion is notify_on is the
  // canonical location:
  if (!r.success) throw new Error("expected success");
  expect(r.data.watches[0].notify_on).toEqual(["confirmed"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/domain/schemas/WatchesConfig.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement `src/domain/schemas/WatchesConfig.ts`**

Use the existing `src/domain/schemas/Config.ts` as a starting point (copy it), then apply the diff from spec section "Diff vs current YAML". Concretely:

```ts
import { isValidFiveFieldCron } from "@domain/services/cronForTimeframe";
import { z } from "zod";

const TimeframeSchema = z.enum(["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"]);

const PreFilterSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(["lenient", "strict", "off"]).default("lenient"),
    thresholds: z
      .object({
        atr_ratio_min: z.number().positive().default(1.3),
        volume_spike_min: z.number().positive().default(1.5),
        rsi_extreme_distance: z.number().min(0).max(50).default(25),
      })
      .prefault({}),
  })
  .prefault({});

const AnalyzerSchema = z.object({
  provider: z.string(),
  model: z.string(),
  max_tokens: z.number().int().positive().default(2000),
  fetch_higher_timeframe: z.boolean().optional(),
});

const SetupLifecycleSchema = z
  .object({
    ttl_candles: z.number().int().positive(),
    score_initial: z.number().min(0).max(100),
    score_threshold_finalizer: z.number().min(0).max(100),
    score_threshold_dead: z.number().min(0).max(100),
    score_max: z.number().min(0).max(100).default(100),
    invalidation_policy: z.enum(["strict", "wick_tolerant", "confirmed_close"]).default("strict"),
  })
  .refine(
    (s) =>
      s.score_threshold_dead < s.score_initial && s.score_initial < s.score_threshold_finalizer,
    { message: "Doit avoir score_threshold_dead < score_initial < score_threshold_finalizer" },
  );

const NotifyEventSchema = z.enum([
  "confirmed",
  "rejected",
  "tp_hit",
  "sl_hit",
  "invalidated",
  "invalidated_after_confirmed",
  "expired",
]);

const WatchSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  enabled: z.boolean().default(true),
  asset: z.object({ symbol: z.string(), source: z.string() }),
  timeframes: z.object({
    primary: TimeframeSchema,
    higher: z.array(TimeframeSchema).default([]),
  }),
  schedule: z.object({
    detector_cron: z
      .string()
      .optional()
      .refine((cron) => cron === undefined || isValidFiveFieldCron(cron), {
        message:
          "detector_cron must be a 5-field cron (no seconds field — minimum 1-minute interval enforced)",
      }),
    reviewer_cron: z
      .string()
      .optional()
      .refine((cron) => cron === undefined || isValidFiveFieldCron(cron), {
        message: "reviewer_cron must be a 5-field cron",
      }),
    timezone: z.string().default("UTC"),
  }),
  candles: z.object({
    detector_lookback: z.number().int().positive(),
    reviewer_lookback: z.number().int().positive(),
    reviewer_chart_window: z.number().int().positive(),
  }),
  setup_lifecycle: SetupLifecycleSchema,
  history_compaction: z
    .object({
      max_raw_events_in_context: z.number().int().positive().default(40),
      summarize_after_age_hours: z.number().int().positive().default(48),
    })
    .prefault({}),
  deduplication: z
    .object({
      similar_setup_window_candles: z.number().int().positive().default(5),
      similar_price_tolerance_pct: z.number().positive().default(0.5),
    })
    .prefault({}),
  pre_filter: PreFilterSchema,
  analyzers: z.object({
    detector: AnalyzerSchema,
    reviewer: AnalyzerSchema,
    finalizer: AnalyzerSchema,
  }),
  optimization: z
    .object({
      reviewer_skip_when_detector_corroborated: z.boolean().default(true),
    })
    .prefault({}),
  notify_on: z.array(NotifyEventSchema).default([]),
  include_chart_image: z.boolean().default(true),
  include_reasoning: z.boolean().default(true),
  budget: z
    .object({
      max_cost_usd_per_day: z.number().positive().optional(),
      pause_on_budget_exceeded: z.boolean().default(true),
    })
    .prefault({}),
});

const LLMProviderConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("claude-agent-sdk"),
    daily_call_budget: z.number().int().positive().optional(),
    fallback: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("openrouter"),
    base_url: z.url().default("https://openrouter.ai/api/v1"),
    monthly_budget_usd: z.number().positive().optional(),
    fallback: z.string().nullable().default(null),
  }),
]);

export const WatchesConfigSchema = z
  .object({
    version: z.literal(1),
    market_data: z.array(z.string()),
    notifications: z
      .object({
        telegram: z.boolean().default(false),
      })
      .prefault({}),
    llm_providers: z.record(z.string(), LLMProviderConfigSchema),
    artifacts: z.object({
      type: z.enum(["filesystem", "s3"]),
      retention: z
        .object({
          keep_days: z.number().int().positive().default(30),
          keep_for_active_setups: z.boolean().default(true),
        })
        .prefault({}),
    }),
    watches: z.array(WatchSchema),
  })
  .superRefine((cfg, ctx) => {
    for (const watch of cfg.watches) {
      if (!cfg.market_data.includes(watch.asset.source)) {
        ctx.addIssue({
          code: "custom",
          path: ["watches", watch.id, "asset", "source"],
          message: `Source "${watch.asset.source}" inconnue (not in market_data)`,
        });
      }
      for (const role of ["detector", "reviewer", "finalizer"] as const) {
        const provider = watch.analyzers[role].provider;
        if (!cfg.llm_providers[provider]) {
          ctx.addIssue({
            code: "custom",
            path: ["watches", watch.id, "analyzers", role, "provider"],
            message: `Provider "${provider}" inconnu`,
          });
        }
      }
    }
    for (const startName of Object.keys(cfg.llm_providers)) {
      const visited = new Set<string>();
      let cur: string | null = startName;
      while (cur !== null) {
        if (visited.has(cur)) {
          ctx.addIssue({
            code: "custom",
            path: ["llm_providers"],
            message: `Cycle dans le graphe fallback: ${[...visited, cur].join(" → ")}`,
          });
          break;
        }
        visited.add(cur);
        const node: z.infer<typeof LLMProviderConfigSchema> | undefined = cfg.llm_providers[cur];
        cur = node?.fallback ?? null;
      }
    }
    const ids = new Set<string>();
    for (const w of cfg.watches) {
      if (ids.has(w.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["watches"],
          message: `ID dupliqué: ${w.id}`,
        });
      }
      ids.add(w.id);
    }
  });

export type WatchesConfig = z.infer<typeof WatchesConfigSchema>;
export type WatchConfig = z.infer<typeof WatchSchema>;
export type NotifyEvent = z.infer<typeof NotifyEventSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test test/domain/schemas/WatchesConfig.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/schemas/WatchesConfig.ts test/domain/schemas/WatchesConfig.test.ts
git commit -m "feat(schema): add WatchesConfig schema (no infra fields, market_data as array)"
```

---

### Task 6: `loadWatchesConfig`

**Files:**
- Create: `src/config/loadWatchesConfig.ts`
- Create: `test/config/loadWatchesConfig.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/config/loadWatchesConfig.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWatchesConfig, WatchesConfigError } from "@config/loadWatchesConfig";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tf-wc-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const minimal = `
version: 1
market_data: [binance]
llm_providers:
  claude_max: { type: claude-agent-sdk, fallback: null }
artifacts: { type: filesystem }
watches:
  - id: btc-1h
    asset: { symbol: BTCUSDT, source: binance }
    timeframes: { primary: 1h, higher: [] }
    schedule: { detector_cron: "*/15 * * * *" }
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 }
    setup_lifecycle:
      ttl_candles: 50
      score_initial: 25
      score_threshold_finalizer: 80
      score_threshold_dead: 10
      invalidation_policy: strict
    analyzers:
      detector:  { provider: claude_max, model: x }
      reviewer:  { provider: claude_max, model: x }
      finalizer: { provider: claude_max, model: x }
    notify_on: [confirmed]
`;

test("returns null when file does not exist", async () => {
  const cfg = await loadWatchesConfig(join(dir, "absent.yaml"));
  expect(cfg).toBeNull();
});

test("returns parsed WatchesConfig when file is valid", async () => {
  const path = join(dir, "ok.yaml");
  await writeFile(path, minimal);
  const cfg = await loadWatchesConfig(path);
  expect(cfg).not.toBeNull();
  expect(cfg?.watches[0]?.id).toBe("btc-1h");
  expect(cfg?.market_data).toEqual(["binance"]);
});

test("throws WatchesConfigError when YAML is malformed", async () => {
  const path = join(dir, "bad-yaml.yaml");
  await writeFile(path, "this: is: not: valid: yaml: [");
  await expect(loadWatchesConfig(path)).rejects.toThrow(WatchesConfigError);
});

test("throws WatchesConfigError when schema fails", async () => {
  const path = join(dir, "bad-schema.yaml");
  await writeFile(path, "version: 1\nmarket_data: [binance]\nwatches: []\n"); // missing llm_providers/artifacts
  await expect(loadWatchesConfig(path)).rejects.toThrow(WatchesConfigError);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/config/loadWatchesConfig.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement `src/config/loadWatchesConfig.ts`**

```ts
import { type WatchesConfig, WatchesConfigSchema } from "@domain/schemas/WatchesConfig";

export class WatchesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchesConfigError";
  }
}

export async function loadWatchesConfig(path: string): Promise<WatchesConfig | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  let raw: string;
  try {
    raw = await file.text();
  } catch (err) {
    throw new WatchesConfigError(`Failed to read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(raw);
  } catch (err) {
    throw new WatchesConfigError(`Malformed YAML in ${path}: ${(err as Error).message}`);
  }

  const result = WatchesConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new WatchesConfigError(`Invalid watches config in ${path}:\n${issues}`);
  }
  return result.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test test/config/loadWatchesConfig.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config/loadWatchesConfig.ts test/config/loadWatchesConfig.test.ts
git commit -m "feat(config): add loadWatchesConfig (returns null when file absent)"
```

---

### Task 7: `ConsoleNotifier`

**Files:**
- Create: `src/adapters/notify/ConsoleNotifier.ts`
- Create: `test/adapters/notify/ConsoleNotifier.test.ts`

The `Notifier` port (`src/domain/ports/Notifier.ts`) is a single-method interface:

```ts
export interface Notifier {
  send(args: { chatId: string; text: string; parseMode?: "Markdown" | "HTML"; images?: NotificationImage[] }): Promise<{ messageId: number }>;
}
```

`ConsoleNotifier` implements it as a no-network impl that logs the call and returns a synthetic `messageId` (0) so callers don't fail.

- [ ] **Step 1: Write the failing test**

Create `test/adapters/notify/ConsoleNotifier.test.ts`:

```ts
import { expect, test } from "bun:test";
import { ConsoleNotifier } from "@adapters/notify/ConsoleNotifier";

test("ConsoleNotifier.send logs and returns synthetic messageId", async () => {
  const notifier = new ConsoleNotifier();
  const result = await notifier.send({ chatId: "test-chat", text: "hello" });
  expect(typeof result.messageId).toBe("number");
});

test("ConsoleNotifier.send accepts optional parseMode and images without throwing", async () => {
  const notifier = new ConsoleNotifier();
  const result = await notifier.send({
    chatId: "test-chat",
    text: "hi",
    parseMode: "Markdown",
    images: [{ uri: "/tmp/x.png", caption: "chart" }],
  });
  expect(result).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/adapters/notify/ConsoleNotifier.test.ts
```

Expected: import error — file doesn't exist.

- [ ] **Step 3: Implement `src/adapters/notify/ConsoleNotifier.ts`**

```ts
import type { Notifier } from "@domain/ports/Notifier";
import { getLogger } from "@observability/logger";

const log = getLogger({ component: "console-notifier" });

export class ConsoleNotifier implements Notifier {
  async send(args: Parameters<Notifier["send"]>[0]): Promise<{ messageId: number }> {
    log.info(
      {
        chatId: args.chatId,
        text: args.text,
        parseMode: args.parseMode,
        images: args.images?.map((i) => ({ uri: i.uri, caption: i.caption })),
      },
      "notification",
    );
    return { messageId: 0 };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test test/adapters/notify/ConsoleNotifier.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/notify/ConsoleNotifier.ts test/adapters/notify/ConsoleNotifier.test.ts
git commit -m "feat(notify): add ConsoleNotifier (log-only Notifier impl)"
```

---

### Task 8: `MultiNotifier`

**Files:**
- Create: `src/adapters/notify/MultiNotifier.ts`
- Create: `test/adapters/notify/MultiNotifier.test.ts`

`MultiNotifier` is a fan-out wrapper. It implements the `Notifier` port and forwards every `send` call to each delegate sequentially. The returned `messageId` is the **first** delegate's — when the user opts into Telegram, that means the Telegram delegate's real Telegram message ID is preserved (the console delegate always returns 0). If the array is empty, returns `{ messageId: 0 }`.

- [ ] **Step 1: Write the failing test**

Create `test/adapters/notify/MultiNotifier.test.ts`:

```ts
import { expect, test } from "bun:test";
import { MultiNotifier } from "@adapters/notify/MultiNotifier";
import type { Notifier } from "@domain/ports/Notifier";

function spy(returnId: number) {
  const calls: Array<Parameters<Notifier["send"]>[0]> = [];
  const notifier: Notifier = {
    async send(args) {
      calls.push(args);
      return { messageId: returnId };
    },
  };
  return { notifier, calls };
}

test("MultiNotifier forwards send to every delegate in order", async () => {
  const a = spy(11);
  const b = spy(22);
  const multi = new MultiNotifier([a.notifier, b.notifier]);
  const result = await multi.send({ chatId: "c", text: "hello" });
  expect(a.calls).toHaveLength(1);
  expect(b.calls).toHaveLength(1);
  expect(a.calls[0]).toEqual({ chatId: "c", text: "hello" });
  expect(result.messageId).toBe(11); // first delegate wins
});

test("MultiNotifier with empty delegate list returns synthetic messageId 0", async () => {
  const multi = new MultiNotifier([]);
  const result = await multi.send({ chatId: "c", text: "x" });
  expect(result).toEqual({ messageId: 0 });
});

test("MultiNotifier propagates errors from delegates", async () => {
  const failing: Notifier = {
    async send() {
      throw new Error("boom");
    },
  };
  const multi = new MultiNotifier([failing]);
  await expect(multi.send({ chatId: "c", text: "x" })).rejects.toThrow("boom");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/adapters/notify/MultiNotifier.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement `src/adapters/notify/MultiNotifier.ts`**

```ts
import type { Notifier } from "@domain/ports/Notifier";

export class MultiNotifier implements Notifier {
  constructor(private readonly delegates: Notifier[]) {}

  async send(args: Parameters<Notifier["send"]>[0]): Promise<{ messageId: number }> {
    let firstResult: { messageId: number } | null = null;
    for (const d of this.delegates) {
      const r = await d.send(args);
      if (firstResult === null) firstResult = r;
    }
    return firstResult ?? { messageId: 0 };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test test/adapters/notify/MultiNotifier.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/notify/MultiNotifier.ts test/adapters/notify/MultiNotifier.test.ts
git commit -m "feat(notify): add MultiNotifier (fan-out adapter, first delegate's messageId wins)"
```

---

## Phase 2 — Adapter migration to new types

### Task 9: `TelegramNotifier` constructor `{ token }` (drop default chat from ctor)

**Files:**
- Modify: `src/adapters/notify/TelegramNotifier.ts`
- Test: `test/adapters/notify/TelegramNotifier.test.ts`

The `Notifier` port stays unchanged: `send({ chatId, text, parseMode?, images? })` continues to take `chatId` per call so we keep the door open for multi-bot/multi-chat scenarios. We only drop the `default_chat_id` constructor field — callers must pass `chatId` explicitly to `send`.

- [ ] **Step 1: Read current ctor and existing tests**

```bash
rtk proxy cat src/adapters/notify/TelegramNotifier.ts | head -40
rtk proxy cat test/adapters/notify/TelegramNotifier.test.ts | head -40
```

Identify the current ctor shape (likely `{ token, default_chat_id? }`) and any test that relies on a per-instance default.

- [ ] **Step 2: Update tests for the new ctor shape**

In `test/adapters/notify/TelegramNotifier.test.ts`:
- Change every `new TelegramNotifier({ token: "...", default_chat_id: ... })` to `new TelegramNotifier({ token: "..." })`.
- For each call to `notifier.send(...)`, ensure `chatId: "..."` is present in the payload (it should already be, since the port has always required it). Any test that exercised the implicit default by *omitting* `chatId` must now pass it explicitly.

- [ ] **Step 3: Run tests to verify they fail**

```bash
bun test test/adapters/notify/TelegramNotifier.test.ts
```

Expected: type errors and/or runtime failures because the ctor no longer accepts `default_chat_id`.

- [ ] **Step 4: Update the implementation**

In `src/adapters/notify/TelegramNotifier.ts`:
- Change ctor signature to `{ token: string }`. Remove any `default_chat_id` field, parameter, or fallback branch.
- Keep `send({ chatId, text, parseMode?, images? })` exactly as today — it continues to use the `chatId` argument as the destination.
- Keep all formatting/image-upload logic unchanged.

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test test/adapters/notify/TelegramNotifier.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/notify/TelegramNotifier.ts test/adapters/notify/TelegramNotifier.test.ts
git commit -m "refactor(notify): TelegramNotifier ctor takes { token } only (chatId stays per-call)"
```

---

### Task 10: `buildProviderRegistry` signature `(watches, infra, store)`

**Files:**
- Modify: `src/adapters/llm/buildProviderRegistry.ts`
- Test: `test/adapters/llm/buildProviderRegistry.test.ts`

- [ ] **Step 1: Read current shape**

```bash
rtk proxy cat src/adapters/llm/buildProviderRegistry.ts
```

Today: `buildProviderRegistry(config: Config, store): Map<string, LLMProvider>`. Reads `config.llm_providers[name].api_key` (openrouter) and `config.llm_providers[name].workspace_dir` (claude_max).

- [ ] **Step 2: Update the test to use the new signature**

In `test/adapters/llm/buildProviderRegistry.test.ts`:
- Replace any `Config`-shaped fixture with two arguments: a `WatchesConfig` (just `llm_providers` set) and an `InfraConfig` mock.
- Where the fixture had `api_key: "..."` under openrouter or `workspace_dir: "..."` under claude_max, move those to the `InfraConfig` mock (`infra.llm.openrouter_api_key`, `infra.claude.workspace_dir`).

Example minimal `infra` mock for the test:

```ts
const infra = {
  database: { url: "x", pool_size: 1, ssl: false },
  temporal: { address: "x", namespace: "default", task_queues: { scheduler: "s", analysis: "a", notifications: "n" } },
  notifications: { telegram: { bot_token: "t", chat_id: "c" } },
  llm: { openrouter_api_key: "or-test-key" },
  artifacts: { base_dir: "/tmp/a" },
  claude: { workspace_dir: "/tmp/c" },
} as const;
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
bun test test/adapters/llm/buildProviderRegistry.test.ts
```

Expected: type errors / call-site mismatches.

- [ ] **Step 4: Update the implementation**

In `src/adapters/llm/buildProviderRegistry.ts`:
- Signature: `buildProviderRegistry(watches: WatchesConfig, infra: InfraConfig, store: LLMUsageStore): Map<string, LLMProvider>`.
- For `openrouter` providers: read `infra.llm.openrouter_api_key` (throw if `null` and any provider uses openrouter — clear error message: `"OPENROUTER_API_KEY is required because llm_providers.<name>.type = openrouter"`).
- For `claude-agent-sdk` providers: read `infra.claude.workspace_dir`.
- Keep the rest of the logic (provider construction, fallback wiring) unchanged.

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test test/adapters/llm/buildProviderRegistry.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/llm/buildProviderRegistry.ts test/adapters/llm/buildProviderRegistry.test.ts
git commit -m "refactor(llm): buildProviderRegistry takes (watches, infra, store)"
```

---

## Phase 3 — Container refactor

### Task 11: `buildContainer` accepts `(infra, watches | null, role)`

**Files:**
- Modify: `src/workers/buildContainer.ts`

This task changes the signature only. Consumers (entry points) are not yet migrated — they will fail TypeScript compilation after this commit. Tasks 12-16 fix them. The build is intentionally red between tasks 11 and 16; tests for unrelated subsystems still pass.

- [ ] **Step 1: Replace the existing `buildContainer.ts` entirely**

Use this reference implementation. It supports both standby (`watches === null`) and active modes.

```ts
import { PlaywrightChartRenderer } from "@adapters/chart/PlaywrightChartRenderer";
import { PureJsIndicatorCalculator } from "@adapters/indicators/PureJsIndicatorCalculator";
import { buildProviderRegistry } from "@adapters/llm/buildProviderRegistry";
import { BinanceFetcher } from "@adapters/market-data/BinanceFetcher";
import { YahooFinanceFetcher } from "@adapters/market-data/YahooFinanceFetcher";
import { ConsoleNotifier } from "@adapters/notify/ConsoleNotifier";
import { MultiNotifier } from "@adapters/notify/MultiNotifier";
import { TelegramNotifier } from "@adapters/notify/TelegramNotifier";
import { FilesystemArtifactStore } from "@adapters/persistence/FilesystemArtifactStore";
import { PostgresEventStore } from "@adapters/persistence/PostgresEventStore";
import { PostgresLLMUsageStore } from "@adapters/persistence/PostgresLLMUsageStore";
import { PostgresSetupRepository } from "@adapters/persistence/PostgresSetupRepository";
import { PostgresTickSnapshotStore } from "@adapters/persistence/PostgresTickSnapshotStore";
import { BinanceWsPriceFeed } from "@adapters/price-feed/BinanceWsPriceFeed";
import { YahooPollingPriceFeed } from "@adapters/price-feed/YahooPollingPriceFeed";
import { SystemClock } from "@adapters/time/SystemClock";
import type { InfraConfig } from "@config/InfraConfig";
import { parseTimeframeToMs } from "@domain/ports/Clock";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Notifier } from "@domain/ports/Notifier";
import type { PriceFeed } from "@domain/ports/PriceFeed";
import type { WatchesConfig } from "@domain/schemas/WatchesConfig";
import { Client, Connection } from "@temporalio/client";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

export type WorkerRole = "scheduler" | "analysis" | "notification";

export type Container = {
  deps: ActivityDeps;
  pgPool: pg.Pool;
  chartRenderer: PlaywrightChartRenderer | null;
  shutdown: () => Promise<void>;
};

export async function buildContainer(
  infra: InfraConfig,
  watches: WatchesConfig | null,
  role: WorkerRole,
): Promise<Container> {
  const pool = new pg.Pool({
    connectionString: infra.database.url,
    max: infra.database.pool_size,
    ssl: infra.database.ssl,
  });
  const db = drizzle(pool);

  // Persistence — needed in standby and active.
  const setupRepo = new PostgresSetupRepository(db, parseTimeframeToMs);
  const eventStore = new PostgresEventStore(db);
  const tickSnapshotStore = new PostgresTickSnapshotStore(db);
  const artifactStore = new FilesystemArtifactStore(db, infra.artifacts.base_dir);
  const llmUsageStore = new PostgresLLMUsageStore(db);
  const clock = new SystemClock();

  // Standby — no watches, no domain wiring.
  if (watches === null) {
    const deps: ActivityDeps = {
      marketDataFetchers: new Map<string, MarketDataFetcher>(),
      chartRenderer: null as unknown as PlaywrightChartRenderer,
      indicatorCalculator: null as unknown as PureJsIndicatorCalculator,
      llmProviders: new Map<string, LLMProvider>(),
      priceFeeds: new Map<string, PriceFeed>(),
      notifier: null as unknown as Notifier,
      setupRepo,
      eventStore,
      artifactStore,
      tickSnapshotStore,
      clock,
      config: null as unknown as WatchesConfig,
      infra,
      watchById: () => undefined,
      temporalClient: null as unknown as Client,
      db,
    };
    return {
      deps,
      pgPool: pool,
      chartRenderer: null,
      async shutdown() {
        await pool.end();
      },
    };
  }

  // Active mode — full wiring.
  const marketDataFetchers = new Map<string, MarketDataFetcher>();
  if (role === "scheduler") {
    if (watches.market_data.includes("binance")) {
      marketDataFetchers.set("binance", new BinanceFetcher());
    }
    if (watches.market_data.includes("yahoo")) {
      marketDataFetchers.set("yahoo", new YahooFinanceFetcher());
    }
  }

  let chartRenderer: PlaywrightChartRenderer | null = null;
  if (role === "scheduler") {
    chartRenderer = new PlaywrightChartRenderer({ poolSize: 2 });
    await chartRenderer.warmUp();
  }

  const indicatorCalculator = role === "scheduler" ? new PureJsIndicatorCalculator() : null;

  const llmProviders =
    role === "notification"
      ? new Map<string, LLMProvider>()
      : buildProviderRegistry(watches, infra, llmUsageStore);

  // Notifier — console always (when active); telegram appended if opted in.
  // The chatId is resolved per-call by activities from `deps.infra.notifications.telegram.chat_id`.
  const consoleNotifier = new ConsoleNotifier();
  let notifier: Notifier;
  if (watches.notifications.telegram) {
    notifier = new MultiNotifier([
      consoleNotifier,
      new TelegramNotifier({ token: infra.notifications.telegram.bot_token }),
    ]);
  } else {
    notifier = consoleNotifier;
  }
  // Notifier is only registered on workers that actually emit notifications.
  const effectiveNotifier =
    role === "notification" || role === "analysis" ? notifier : (null as unknown as Notifier);

  const priceFeeds = new Map<string, PriceFeed>();
  if (role === "scheduler") {
    priceFeeds.set("binance_ws", new BinanceWsPriceFeed());
    priceFeeds.set("yahoo_polling", new YahooPollingPriceFeed());
  }

  const watchById = (id: string) => watches.watches.find((w) => w.id === id);

  let temporalConnection: Connection | null = null;
  let temporalClient: Client | null = null;
  if (role === "scheduler") {
    temporalConnection = await Connection.connect({ address: infra.temporal.address });
    temporalClient = new Client({
      connection: temporalConnection,
      namespace: infra.temporal.namespace,
    });
  }

  const deps: ActivityDeps = {
    marketDataFetchers,
    chartRenderer: chartRenderer ?? (null as unknown as PlaywrightChartRenderer),
    indicatorCalculator: indicatorCalculator ?? (null as unknown as PureJsIndicatorCalculator),
    llmProviders,
    priceFeeds,
    notifier: effectiveNotifier,
    setupRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock,
    config: watches,
    infra,
    watchById,
    temporalClient: temporalClient ?? (null as unknown as Client),
    db,
  };

  return {
    deps,
    pgPool: pool,
    chartRenderer,
    async shutdown() {
      if (chartRenderer) await chartRenderer.dispose();
      if (temporalConnection) await temporalConnection.close();
      await pool.end();
    },
  };
}
```

Note: the `ActivityDeps.config` field today is typed `Config`. After Task 16 deletes `Config.ts`, that field's type will become `WatchesConfig` (renaming required at the field declaration too — see Task 12 for activityDependencies.ts).

- [ ] **Step 2: Verify by typechecking once consumers are migrated**

The build is red until Tasks 12-16 finish. Skip a `bun test` here — run it after Task 16.

- [ ] **Step 3: Commit**

```bash
git add src/workers/buildContainer.ts
git commit -m "refactor(workers): buildContainer takes (infra, watches | null, role) with standby branch"
```

---

### Task 12: Update `ActivityDeps` (WatchesConfig + infra) and migrate setup activities

**Files:**
- Modify: `src/workflows/activityDependencies.ts`
- Modify: `src/workflows/setup/activities.ts`

This task updates `ActivityDeps` to (a) type `config` as `WatchesConfig` instead of `Config` and (b) add a new `infra: InfraConfig` field. It then migrates the six `notifier.send` call sites in `setup/activities.ts` to source `chatId` from `deps.infra.notifications.telegram.chat_id` and to read `notify_on`, `include_chart_image`, `include_reasoning` from the watch's top-level (the schema migration in Task 5 hoisted them).

`src/workflows/notification/activities.ts` is **not** changed — it's a generic passthrough whose `notifyTelegram` activity already takes `chatId` in its input. Future workflows can call it with whatever chat they want; today no production caller exists.

- [ ] **Step 1: Read current shape and identify call sites**

```bash
rtk proxy cat src/workflows/activityDependencies.ts
rtk proxy bash -c 'grep -rn "deps\.config\|watch\.notifications\." src/'
```

Note every reference to `deps.config.<field>` and `watch.notifications.<field>` — they're the migration surface.

- [ ] **Step 2: Update `ActivityDeps`**

In `src/workflows/activityDependencies.ts`:
- Replace `import type { Config } from "@domain/schemas/Config";` with `import type { WatchesConfig } from "@domain/schemas/WatchesConfig";`.
- Add `import type { InfraConfig } from "@config/InfraConfig";`.
- Change the `config: Config` field declaration to `config: WatchesConfig`.
- Add a new field `infra: InfraConfig;` adjacent to `config`.

- [ ] **Step 3: Update the six `notifier.send` calls in `setup/activities.ts`**

In `src/workflows/setup/activities.ts`, for each of the six activities (`notifyTelegramConfirmed`, `notifyTelegramRejected`, `notifyTelegramInvalidatedAfterConfirmed`, `notifyTelegramTPHit`, `notifyTelegramSLHit`, `notifyTelegramExpired`):

1. Replace `chatId: watch.notifications.telegram_chat_id` with `chatId: deps.infra.notifications.telegram.chat_id`.
2. Replace any read of `watch.notifications.notify_on.includes(...)` with `watch.notify_on.includes(...)`.
3. Replace `watch.notifications.include_chart_image` with `watch.include_chart_image`.
4. Replace `watch.notifications.include_reasoning` with `watch.include_reasoning`.

Do not change anything else in those activities (text formatting, image handling, logging).

- [ ] **Step 4: Sanity-check no `watch.notifications.` reference remains**

```bash
rtk proxy bash -c 'grep -rn "watch\.notifications\." src/'
```

Expected: no matches.

- [ ] **Step 5: Run unit tests for the touched modules**

```bash
bun test test/workflows/setup
```

Expected: tests in this directory either pass or fail only on issues unrelated to field renames. If a test references the old shape, fix it inline (rename `notifications.telegram_chat_id` → top-level access via deps mock, etc.). The setup workflow tests use `FakeNotifier` and `InMemory*` stores — `deps.infra` must be provided there. Add a minimal `infra` mock to whatever test helper builds the deps for setup tests:

```ts
const infraStub = {
  database: { url: "x", pool_size: 1, ssl: false },
  temporal: { address: "x", namespace: "default", task_queues: { scheduler: "s", analysis: "a", notifications: "n" } },
  notifications: { telegram: { bot_token: "tok", chat_id: "test-chat" } },
  llm: { openrouter_api_key: null },
  artifacts: { base_dir: "/tmp" },
  claude: { workspace_dir: "/tmp" },
};
```

- [ ] **Step 6: Commit**

```bash
git add src/workflows/activityDependencies.ts src/workflows/setup/activities.ts <updated test files>
git commit -m "refactor(workflows): ActivityDeps gets WatchesConfig + infra; setup activities source chatId from infra"
```

---

## Phase 4 — Entry-point migration

Each entry point follows the same pattern. The pattern is shown in detail in Task 13 (`scheduler-worker`). Tasks 14-17 reuse this pattern; their steps reference back to it.

### Task 13: `scheduler-worker.ts`

**Files:**
- Modify: `src/workers/scheduler-worker.ts`

- [ ] **Step 1: Replace the file with the new pattern**

```ts
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildPriceMonitorActivities } from "@workflows/price-monitor/activities";
import { buildSchedulerActivities } from "@workflows/scheduler/activities";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "scheduler-worker" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const infra = loadInfraConfig();
const watches = await loadWatchesConfig(configPath);

const healthPort = Number(process.env.HEALTH_PORT ?? 8081);
const health = new HealthServer("scheduler-worker", healthPort);
health.start();

if (watches === null) {
  const container = await buildContainer(infra, null, "scheduler");
  health.setStatus("standby", { reason: "no watches.yaml — system idle, drop the file and restart" });
  log.info({ configPath }, "standby: no watches.yaml — idle (Temporal worker not registered)");
  await new Promise<void>((resolve) => process.once("SIGTERM", () => resolve()));
  log.info("shutting down (standby)");
  await health.stop();
  await container.shutdown();
  process.exit(0);
}

const container = await buildContainer(infra, watches, "scheduler");
const connection = await NativeConnection.connect({ address: infra.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: infra.temporal.namespace,
  taskQueue: infra.temporal.task_queues.scheduler,
  workflowsPath: require.resolve("../workflows/scheduler/index.ts"),
  activities: {
    ...buildSchedulerActivities(container.deps),
    ...buildPriceMonitorActivities(container.deps),
  },
});

log.info({ taskQueue: infra.temporal.task_queues.scheduler }, "starting");

const healthTick = setInterval(() => {
  const runState = worker.getState();
  if (runState === "FAILED" || runState === "STOPPED") {
    health.setStatus("down", { workerStatus: runState });
  } else if (runState === "DRAINING" || runState === "DRAINED" || runState === "STOPPING") {
    health.setStatus("degraded", { workerStatus: runState });
  } else {
    health.setStatus("ok", { workerStatus: runState });
  }
  health.setActivity();
}, 5_000);

process.on("SIGTERM", async () => {
  log.info("shutting down");
  clearInterval(healthTick);
  health.setStatus("down");
  await health.stop();
  worker.shutdown();
  await container.shutdown();
});
await worker.run();
```

- [ ] **Step 2: Sanity-check imports compile**

```bash
bun build src/workers/scheduler-worker.ts --target=bun --outdir=/tmp/tf-build-check 2>&1 | head -20
```

Expected: no TypeScript errors related to the touched code (other entry points may still have errors — that's expected).

- [ ] **Step 3: Commit**

```bash
git add src/workers/scheduler-worker.ts
git commit -m "refactor(scheduler-worker): infra+watches loaders + standby branch"
```

---

### Task 14: `analysis-worker.ts`

**Files:**
- Modify: `src/workers/analysis-worker.ts`

- [ ] **Step 1: Replace the file using the same pattern as Task 13**

Differences vs scheduler-worker:
- `health = new HealthServer("analysis-worker", healthPort)`, default port `8082`.
- `taskQueue: infra.temporal.task_queues.analysis`.
- `workflowsPath: require.resolve("../workflows/setup/setupWorkflow.ts")`.
- `activities: buildSetupActivities(container.deps)`.
- Role `"analysis"` (not `"scheduler"`).

```ts
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildSetupActivities } from "@workflows/setup/activities";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "analysis-worker" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const infra = loadInfraConfig();
const watches = await loadWatchesConfig(configPath);

const healthPort = Number(process.env.HEALTH_PORT ?? 8082);
const health = new HealthServer("analysis-worker", healthPort);
health.start();

if (watches === null) {
  const container = await buildContainer(infra, null, "analysis");
  health.setStatus("standby", { reason: "no watches.yaml — system idle, drop the file and restart" });
  log.info({ configPath }, "standby: no watches.yaml — idle (Temporal worker not registered)");
  await new Promise<void>((resolve) => process.once("SIGTERM", () => resolve()));
  log.info("shutting down (standby)");
  await health.stop();
  await container.shutdown();
  process.exit(0);
}

const container = await buildContainer(infra, watches, "analysis");
const connection = await NativeConnection.connect({ address: infra.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: infra.temporal.namespace,
  taskQueue: infra.temporal.task_queues.analysis,
  workflowsPath: require.resolve("../workflows/setup/setupWorkflow.ts"),
  activities: buildSetupActivities(container.deps),
});

log.info({ taskQueue: infra.temporal.task_queues.analysis }, "starting");

const healthTick = setInterval(() => {
  const runState = worker.getState();
  if (runState === "FAILED" || runState === "STOPPED") {
    health.setStatus("down", { workerStatus: runState });
  } else if (runState === "DRAINING" || runState === "DRAINED" || runState === "STOPPING") {
    health.setStatus("degraded", { workerStatus: runState });
  } else {
    health.setStatus("ok", { workerStatus: runState });
  }
  health.setActivity();
}, 5_000);

process.on("SIGTERM", async () => {
  log.info("shutting down");
  clearInterval(healthTick);
  health.setStatus("down");
  await health.stop();
  worker.shutdown();
  await container.shutdown();
});
await worker.run();
```

- [ ] **Step 2: Commit**

```bash
git add src/workers/analysis-worker.ts
git commit -m "refactor(analysis-worker): infra+watches loaders + standby branch"
```

---

### Task 15: `notification-worker.ts`

**Files:**
- Modify: `src/workers/notification-worker.ts`

- [ ] **Step 1: Replace the file using the same pattern as Task 13**

Differences vs scheduler-worker:
- `health = new HealthServer("notification-worker", healthPort)`, default port `8083`.
- `taskQueue: infra.temporal.task_queues.notifications`.
- No `workflowsPath` (notification worker only registers activities).
- `activities: buildNotificationActivities(container.deps)`.
- Role `"notification"`.

```ts
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildNotificationActivities } from "@workflows/notification/activities";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "notification-worker" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const infra = loadInfraConfig();
const watches = await loadWatchesConfig(configPath);

const healthPort = Number(process.env.HEALTH_PORT ?? 8083);
const health = new HealthServer("notification-worker", healthPort);
health.start();

if (watches === null) {
  const container = await buildContainer(infra, null, "notification");
  health.setStatus("standby", { reason: "no watches.yaml — system idle, drop the file and restart" });
  log.info({ configPath }, "standby: no watches.yaml — idle (Temporal worker not registered)");
  await new Promise<void>((resolve) => process.once("SIGTERM", () => resolve()));
  log.info("shutting down (standby)");
  await health.stop();
  await container.shutdown();
  process.exit(0);
}

const container = await buildContainer(infra, watches, "notification");
const connection = await NativeConnection.connect({ address: infra.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: infra.temporal.namespace,
  taskQueue: infra.temporal.task_queues.notifications,
  activities: buildNotificationActivities(container.deps),
});

log.info({ taskQueue: infra.temporal.task_queues.notifications }, "starting");

const healthTick = setInterval(() => {
  const runState = worker.getState();
  if (runState === "FAILED" || runState === "STOPPED") {
    health.setStatus("down", { workerStatus: runState });
  } else if (runState === "DRAINING" || runState === "DRAINED" || runState === "STOPPING") {
    health.setStatus("degraded", { workerStatus: runState });
  } else {
    health.setStatus("ok", { workerStatus: runState });
  }
  health.setActivity();
}, 5_000);

process.on("SIGTERM", async () => {
  log.info("shutting down");
  clearInterval(healthTick);
  health.setStatus("down");
  await health.stop();
  worker.shutdown();
  await container.shutdown();
});
await worker.run();
```

- [ ] **Step 2: Commit**

```bash
git add src/workers/notification-worker.ts
git commit -m "refactor(notification-worker): infra+watches loaders + standby branch"
```

---

### Task 16: `bootstrap-schedules.ts`

**Files:**
- Modify: `src/cli/bootstrap-schedules.ts`

- [ ] **Step 1: Replace the file**

```ts
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
import { cronForTimeframe } from "@domain/services/cronForTimeframe";
import { getLogger } from "@observability/logger";
import { Client, Connection, ScheduleNotFoundError } from "@temporalio/client";
import { pickPriceFeedAdapter } from "@workflows/price-monitor/activities";
import { priceMonitorWorkflowId } from "@workflows/price-monitor/priceMonitorWorkflow";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const log = getLogger({ component: "bootstrap-schedules" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const infra = loadInfraConfig();
const watches = await loadWatchesConfig(configPath);

if (watches === null) {
  log.info({ configPath }, "standby: no watches.yaml — skipping schedule bootstrap");
  process.exit(0);
}

const connection = await Connection.connect({ address: infra.temporal.address });
const client = new Client({ connection, namespace: infra.temporal.namespace });

for (const watch of watches.watches.filter((w) => w.enabled)) {
  const watchLog = log.child({ watchId: watch.id });
  const cron = watch.schedule.detector_cron ?? cronForTimeframe(watch.timeframes.primary);
  watchLog.info(
    {
      timeframe: watch.timeframes.primary,
      cron,
      derived: !watch.schedule.detector_cron,
    },
    "schedule cron",
  );
  await client.workflow
    .start("schedulerWorkflow", {
      args: [
        {
          watchId: watch.id,
          analysisTaskQueue: infra.temporal.task_queues.analysis,
        },
      ],
      workflowId: schedulerWorkflowId(watch.id),
      taskQueue: infra.temporal.task_queues.scheduler,
    })
    .catch((err: Error) => {
      if (!/already running|already started|alreadystarted/i.test(err.message)) throw err;
    });

  await client.workflow
    .start("priceMonitorWorkflow", {
      args: [{ watchId: watch.id, adapter: pickPriceFeedAdapter(watch.asset.source) }],
      workflowId: priceMonitorWorkflowId(watch.id),
      taskQueue: infra.temporal.task_queues.scheduler,
    })
    .catch((err: Error) => {
      if (!/already running|already started|alreadystarted/i.test(err.message)) throw err;
    });

  const scheduleId = `tick-${watch.id}`;
  const handle = client.schedule.getHandle(scheduleId);
  try {
    await handle.describe();
    await handle.update((current) => ({
      ...current,
      spec: {
        cronExpressions: [cron],
        timezone: watch.schedule.timezone ?? "UTC",
      },
    }));
    watchLog.info("updated schedule");
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) {
      await client.schedule.create({
        scheduleId,
        spec: {
          cronExpressions: [cron],
          timezone: watch.schedule.timezone ?? "UTC",
        },
        action: {
          type: "startWorkflow",
          workflowType: "tickStarterWorkflow",
          workflowId: `tick-starter-${watch.id}`,
          taskQueue: infra.temporal.task_queues.scheduler,
          args: [{ watchId: watch.id }],
        },
      });
      watchLog.info("created schedule");
    } else throw err;
  }
}

log.info("done");
process.exit(0);
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/bootstrap-schedules.ts
git commit -m "refactor(bootstrap-schedules): infra+watches loaders + exit 0 in standby"
```

---

### Task 17: `reload-config.ts`

**Files:**
- Modify: `src/cli/reload-config.ts`

- [ ] **Step 1: Replace the file**

```ts
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const log = getLogger({ component: "reload-config" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const dryRun = process.argv.includes("--dry-run");

const infra = loadInfraConfig();
const watches = await loadWatchesConfig(configPath);

if (watches === null) {
  log.info({ configPath }, "no watches.yaml — nothing to reload");
  process.exit(0);
}

log.info({ count: watches.watches.length, configPath }, "loaded watches");

if (dryRun) {
  log.info("--dry-run, exiting before applying");
  process.exit(0);
}

const connection = await Connection.connect({ address: infra.temporal.address });
const client = new Client({ connection, namespace: infra.temporal.namespace });

for (const watch of watches.watches.filter((w) => w.enabled)) {
  const watchLog = log.child({ watchId: watch.id });
  try {
    await client.workflow.getHandle(schedulerWorkflowId(watch.id)).signal("reloadConfig", watch);
    watchLog.info("sent reloadConfig");
  } catch (err) {
    watchLog.warn({ err: (err as Error).message }, "could not reload");
  }
}

log.info("done. Note: cron schedule changes require running bootstrap-schedules again.");
process.exit(0);
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/reload-config.ts
git commit -m "refactor(reload-config): infra+watches loaders + exit 0 in standby"
```

---

## Phase 5 — Cleanup of legacy modules

### Task 18: Delete `loadConfig.ts` and old `Config.ts` schema

**Files:**
- Delete: `src/config/loadConfig.ts`
- Delete: `src/domain/schemas/Config.ts`
- Delete: `test/config/loadConfig.test.ts`
- Delete: `test/domain/schemas/Config.test.ts`

- [ ] **Step 1: Confirm no consumer remains**

```bash
rtk proxy bash -c 'grep -rn "@config/loadConfig\|@domain/schemas/Config\b" src/ test/'
```

Expected: empty output. If anything matches, fix that consumer first (likely a missed entry point or test).

- [ ] **Step 2: Delete the files**

```bash
rm src/config/loadConfig.ts
rm src/domain/schemas/Config.ts
rm test/config/loadConfig.test.ts
rm test/domain/schemas/Config.test.ts
```

- [ ] **Step 3: Run the full suite**

```bash
bun test
```

Expected: every test passes. If a test references the deleted modules, delete or migrate that test (likely it was a direct test of the old shape — its replacement is in Task 5/6).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(config): remove legacy loadConfig + Config schema (replaced by infra/watches split)"
```

---

## Phase 6 — Operational config

### Task 19: `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Read current**

```bash
rtk proxy cat docker-compose.yml | head -50
```

- [ ] **Step 2: Apply three edits**

Edit 1 — Postgres healthcheck switches to TCP via service name (this is the OrbStack network-attach race fix):

Find:
```yaml
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]
```

Replace with:
```yaml
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h postgres -U $${POSTGRES_USER}"]
```

Edit 2 — Drop `ANTHROPIC_API_KEY` from the worker env block:

Find:
```yaml
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
```

Delete that line.

Edit 3 — Add the new env vars (with sensible defaults that mirror `loadInfraConfig`'s fallbacks). Inside the `&worker_env` anchor block, after the existing entries:

```yaml
      DATABASE_POOL_SIZE: ${DATABASE_POOL_SIZE:-10}
      DATABASE_SSL: ${DATABASE_SSL:-false}
      TEMPORAL_NAMESPACE: ${TEMPORAL_NAMESPACE:-default}
      TEMPORAL_TASK_QUEUE_SCHEDULER: ${TEMPORAL_TASK_QUEUE_SCHEDULER:-scheduler}
      TEMPORAL_TASK_QUEUE_ANALYSIS: ${TEMPORAL_TASK_QUEUE_ANALYSIS:-analysis}
      TEMPORAL_TASK_QUEUE_NOTIFICATIONS: ${TEMPORAL_TASK_QUEUE_NOTIFICATIONS:-notifications}
      ARTIFACTS_BASE_DIR: ${ARTIFACTS_BASE_DIR:-/data/artifacts}
      CLAUDE_WORKSPACE_DIR: ${CLAUDE_WORKSPACE_DIR:-/data/claude-workspace}
```

Also add `migrate` service block: it only needs `DATABASE_URL` — leave it as is.

- [ ] **Step 3: Verify the compose file is valid**

```bash
docker compose config 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(compose): TCP postgres healthcheck (OrbStack fix), drop ANTHROPIC_API_KEY, add infra env vars"
```

---

### Task 20: `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Replace the file content**

```bash
# === Database ===
POSTGRES_USER=trading_flow
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgres://trading_flow:change-me@localhost:5432/trading_flow
DATABASE_POOL_SIZE=10
DATABASE_SSL=false

# === Temporal ===
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE_SCHEDULER=scheduler
TEMPORAL_TASK_QUEUE_ANALYSIS=analysis
TEMPORAL_TASK_QUEUE_NOTIFICATIONS=notifications

# === Telegram (required) ===
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# === LLM providers (optional — only needed if a provider in watches.yaml uses them) ===
OPENROUTER_API_KEY=

# === Filesystem (operational) ===
ARTIFACTS_BASE_DIR=/data/artifacts
CLAUDE_WORKSPACE_DIR=/data/claude-workspace
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "chore(env): refresh .env.example with new infra env vars"
```

---

### Task 21: `config/watches.yaml.example`

**Files:**
- Modify: `config/watches.yaml.example`

- [ ] **Step 1: Replace the file content**

```yaml
version: 1

# White-list of enabled market data sources.
# Base URLs are hardcoded in the adapters — this is just an opt-in switch.
market_data: [binance]

# Notification channels. Console is always active; opt-in for the rest.
notifications:
  telegram: true

# LLM providers. Credentials and filesystem paths are env-driven (see .env).
llm_providers:
  claude_max:
    type: claude-agent-sdk
    daily_call_budget: 800
    fallback: openrouter
  openrouter:
    type: openrouter
    monthly_budget_usd: 50
    fallback: null

# Artifact retention policy (the base directory itself is in ARTIFACTS_BASE_DIR).
artifacts:
  type: filesystem
  retention:
    keep_days: 30
    keep_for_active_setups: true

# User-defined trading watches.
watches:
  - id: btc-1h
    enabled: true
    asset: { symbol: BTCUSDT, source: binance }
    timeframes: { primary: 1h, higher: [4h] }
    schedule:
      timezone: UTC
    candles:
      detector_lookback: 200
      reviewer_lookback: 500
      reviewer_chart_window: 150
    setup_lifecycle:
      ttl_candles: 50
      score_initial: 25
      score_threshold_finalizer: 80
      score_threshold_dead: 10
      invalidation_policy: strict
    deduplication:
      similar_setup_window_candles: 5
      similar_price_tolerance_pct: 0.5
    pre_filter:
      enabled: true
      mode: lenient
      thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 }
    analyzers:
      detector:  { provider: claude_max, model: claude-sonnet-4-6 }
      reviewer:  { provider: claude_max, model: claude-haiku-4-5 }
      finalizer: { provider: claude_max, model: claude-opus-4-7 }
    optimization:
      reviewer_skip_when_detector_corroborated: true
    notify_on: [confirmed, tp_hit, sl_hit, invalidated_after_confirmed]
    budget:
      max_cost_usd_per_day: 5.00
```

- [ ] **Step 2: Commit**

```bash
git add config/watches.yaml.example
git commit -m "chore(config): refresh watches.yaml.example with new shape (no \${...} interpolation)"
```

---

## Phase 7 — End-to-end smoke test

### Task 22: Smoke integration test for standby boot

**Files:**
- Create: `test/integration/standby-boot.test.ts`

This is a guarded integration test (only runs with `RUN_INTEGRATION_STANDBY=1`) so it doesn't run on every `bun test`. It validates the full docker-compose flow.

- [ ] **Step 1: Write the test**

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rename, stat } from "node:fs/promises";
import { join } from "node:path";

const RUN = process.env.RUN_INTEGRATION_STANDBY === "1";
const repoRoot = new URL("../..", import.meta.url).pathname;
const watchesPath = join(repoRoot, "config", "watches.yaml");
const watchesBackupPath = `${watchesPath}.bak-standby-test`;

beforeAll(async () => {
  if (!RUN) return;
  // Move aside any existing watches.yaml so the stack boots in standby.
  try {
    await stat(watchesPath);
    await rename(watchesPath, watchesBackupPath);
  } catch {
    // file did not exist — nothing to back up
  }
});

afterAll(async () => {
  if (!RUN) return;
  // Restore the backup and tear the stack down.
  try {
    await stat(watchesBackupPath);
    await rename(watchesBackupPath, watchesPath);
  } catch {
    // no backup
  }
  await Bun.$`docker compose -f ${join(repoRoot, "docker-compose.yml")} down`.quiet();
});

test.skipIf(!RUN)("docker compose up boots into standby with no watches.yaml", async () => {
  // Bring the stack up detached.
  const up = await Bun.$`docker compose -f ${join(repoRoot, "docker-compose.yml")} up -d --wait --wait-timeout 120`;
  expect(up.exitCode).toBe(0);

  // Each worker exposes /health on its respective port (mapped to localhost via 127.0.0.1).
  const ports = [8081, 8082, 8083]; // scheduler, analysis, notification
  for (const port of ports) {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("standby");
  }
});
```

- [ ] **Step 2: Add the test script to `package.json`**

In `package.json`, add to `scripts`:

```json
    "test:integration:standby": "RUN_INTEGRATION_STANDBY=1 bun test test/integration/standby-boot.test.ts",
```

(Choose a sensible alphabetical position among the other `test:*` scripts.)

- [ ] **Step 3: Run the test**

```bash
bun run test:integration:standby
```

Expected: passes within ~2 minutes (`--wait` blocks until containers are healthy).

If `bootstrap-schedules` is configured to be `service_completed_successfully` for downstream workers (see compose file), it must exit 0 in standby (which Task 16 ensures), otherwise the workers won't start. Verify that's the case before running this test.

- [ ] **Step 4: Commit**

```bash
git add test/integration/standby-boot.test.ts package.json
git commit -m "test(integration): smoke test — stack boots in standby with no watches.yaml"
```

---

## Self-review checklist

After all tasks complete, run end-to-end:

- [ ] `bun test` — all unit and lightweight integration tests pass.
- [ ] `bun run test:integration:standby` — standby smoke passes.
- [ ] With a real `config/watches.yaml` in place, `docker compose up -d` brings up everything healthy and `/health` returns `"ok"` (not `"standby"`) on each worker.
- [ ] `bun run lint` — Biome reports clean.
- [ ] `git grep "loadConfig\b"` returns zero hits in `src/` and `test/`.
- [ ] `git grep "expandEnvVars"` returns zero hits.
- [ ] `git grep "ANTHROPIC_API_KEY"` only appears in `test/llm/claudeSmoke.test.ts`.
