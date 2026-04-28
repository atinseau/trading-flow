# tf-web Frontend & Real-Time Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `tf-web` Bun.serve container that exposes a trader-friendly React UI for editing the watches[] config (now stored in Postgres) and monitoring setups, scores, and events in real time over SSE — without modifying the bot's runtime workflows, activities, or scoring logic.

**Architecture:** A single new container (`tf-web`) running `bun run src/client/server.ts` that hosts the React frontend via Bun.serve HTML imports and serves a REST + SSE API at `/api/*`. The bot's `watches:` array moves from `config/watches.yaml` to a new Postgres table `watch_configs`; the YAML continues to provide global infra (`llm_providers`, `notifications.telegram`, `database`, `temporal`, `market_data`). Existing CLI logic (`bootstrap-schedules`, `reload-config`, `pause-watch`, `kill-setup`, `force-tick`) is extracted into reusable helpers in `src/config/` that both the CLIs and `tf-web` consume.

**Tech Stack:**
- Backend: Bun.serve, Drizzle (existing schema reused + extended), `@temporalio/client`, pino, Zod (existing `WatchSchema`)
- Frontend: React 19, react-router-dom v7, TanStack Query v5, shadcn/ui (Tailwind v4 first, v3 fallback if `bun-plugin-tailwind` doesn't yet support v4), `lightweight-charts` (already in deps), recharts (via shadcn `chart`), react-hook-form + zodResolver
- Tests: `bun test`, testcontainers Postgres (existing helper), Playwright (already in deps), `@happy-dom/global-registrator` + `@testing-library/react` for hooks/components
- Spec: `docs/superpowers/specs/2026-04-28-frontend-watches-config-design.md`

---

## Phase 0 — DB schema and config refactor (foundational)

### Task 1: Add `watch_configs` and `watch_config_revisions` tables to Drizzle schema

**Files:**
- Modify: `src/adapters/persistence/schema.ts`
- Generate: `migrations/0002_add_watch_configs.sql` (via drizzle-kit)
- Test: `test/adapters/persistence/watchConfigsSchema.test.ts`

- [ ] **Step 1: Append the new tables to the existing schema file**

Open `src/adapters/persistence/schema.ts` and add these definitions at the bottom (do not touch the existing tables):

```ts
export const watchConfigs = pgTable(
  "watch_configs",
  {
    id: text("id").primaryKey(),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").$type<unknown>().notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("idx_watch_configs_enabled").on(t.enabled)],
);

export const watchConfigRevisions = pgTable(
  "watch_config_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchId: text("watch_id")
      .notNull()
      .references(() => watchConfigs.id, { onDelete: "cascade" }),
    config: jsonb("config").$type<unknown>().notNull(),
    version: integer("version").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    appliedBy: text("applied_by").notNull().default("ui"),
  },
  (t) => [index("idx_watch_revisions_watch").on(t.watchId, t.appliedAt)],
);
```

- [ ] **Step 2: Generate the migration**

Run: `bunx drizzle-kit generate`
Expected output: a new file `migrations/0002_*.sql` containing `CREATE TABLE watch_configs ...` and `CREATE TABLE watch_config_revisions ...`. Review it visually to confirm the columns match the schema above.

- [ ] **Step 3: Write a smoke test for the new tables**

Create `test/adapters/persistence/watchConfigsSchema.test.ts`:

```ts
import { startTestPostgres } from "@test-helpers/postgres";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { watchConfigs, watchConfigRevisions } from "@adapters/persistence/schema";

describe("watch_configs schema", () => {
  test("insert + read round-trips a watch config", async () => {
    const tp = await startTestPostgres();
    try {
      await tp.db.insert(watchConfigs).values({
        id: "btc-1h",
        enabled: true,
        config: { id: "btc-1h", asset: { symbol: "BTCUSDT", source: "binance" } } as unknown,
        version: 1,
      });
      const [row] = await tp.db.select().from(watchConfigs).where(eq(watchConfigs.id, "btc-1h"));
      expect(row?.id).toBe("btc-1h");
      expect(row?.version).toBe(1);
      expect((row?.config as { id: string }).id).toBe("btc-1h");
    } finally {
      await tp.cleanup();
    }
  });

  test("revisions cascade on watch_configs delete", async () => {
    const tp = await startTestPostgres();
    try {
      await tp.db.insert(watchConfigs).values({
        id: "eth-4h", enabled: true, config: {} as unknown, version: 1,
      });
      await tp.db.insert(watchConfigRevisions).values({
        watchId: "eth-4h", config: {} as unknown, version: 1, appliedBy: "ui",
      });
      await tp.db.delete(watchConfigs).where(eq(watchConfigs.id, "eth-4h"));
      const revs = await tp.db
        .select().from(watchConfigRevisions).where(eq(watchConfigRevisions.watchId, "eth-4h"));
      expect(revs.length).toBe(0);
    } finally {
      await tp.cleanup();
    }
  });
});
```

Add path alias `@test-helpers/*` to `tsconfig.json` if not present:

```json
"@test-helpers/*": ["./test/helpers/*"]
```

- [ ] **Step 4: Run the test**

Run: `bun test test/adapters/persistence/watchConfigsSchema.test.ts`
Expected: 2 tests pass. The migration is auto-applied by `startTestPostgres`.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/persistence/schema.ts migrations/ test/adapters/persistence/watchConfigsSchema.test.ts tsconfig.json
git commit -m "feat(schema): add watch_configs and watch_config_revisions tables

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add `loadWatchesFromDb` helper and refactor `loadConfig`

**Files:**
- Create: `src/config/loadWatchesFromDb.ts`
- Modify: `src/config/loadConfig.ts`
- Test: `test/config/loadWatchesFromDb.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config/loadWatchesFromDb.test.ts`:

```ts
import { startTestPostgres } from "@test-helpers/postgres";
import { describe, expect, test } from "bun:test";
import { watchConfigs } from "@adapters/persistence/schema";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";

const FULL_WATCH = {
  id: "btc-1h",
  enabled: true,
  asset: { symbol: "BTCUSDT", source: "binance" },
  timeframes: { primary: "1h", higher: ["4h"] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50, score_initial: 25,
    score_threshold_finalizer: 80, score_threshold_dead: 10,
    invalidation_policy: "strict",
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6", max_tokens: 2000 },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5", max_tokens: 2000 },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
  },
  notifications: {
    telegram_chat_id: "123",
    notify_on: ["confirmed", "tp_hit", "sl_hit"],
    include_chart_image: true, include_reasoning: true,
  },
};

describe("loadWatchesFromDb", () => {
  test("returns parsed watches, ignoring soft-deleted ones", async () => {
    const tp = await startTestPostgres();
    try {
      await tp.db.insert(watchConfigs).values([
        { id: "btc-1h", enabled: true, config: FULL_WATCH as unknown, version: 1 },
        { id: "old", enabled: false, config: { ...FULL_WATCH, id: "old" } as unknown, version: 1, deletedAt: new Date() },
      ]);
      const watches = await loadWatchesFromDb(tp.pool);
      expect(watches.length).toBe(1);
      expect(watches[0]!.id).toBe("btc-1h");
    } finally {
      await tp.cleanup();
    }
  });

  test("returns empty array when no rows", async () => {
    const tp = await startTestPostgres();
    try {
      const watches = await loadWatchesFromDb(tp.pool);
      expect(watches).toEqual([]);
    } finally {
      await tp.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `bun test test/config/loadWatchesFromDb.test.ts`
Expected: FAIL with `Cannot find module '@config/loadWatchesFromDb'`.

- [ ] **Step 3: Implement `loadWatchesFromDb`**

Create `src/config/loadWatchesFromDb.ts`:

```ts
import { watchConfigs } from "@adapters/persistence/schema";
import { type WatchConfig, WatchSchema } from "@domain/schemas/Config";
import { isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

export async function loadWatchesFromDb(pool: pg.Pool): Promise<WatchConfig[]> {
  const db = drizzle(pool);
  const rows = await db.select().from(watchConfigs).where(isNull(watchConfigs.deletedAt));
  return rows.map((r) => WatchSchema.parse(r.config));
}
```

- [ ] **Step 4: Run the test**

Run: `bun test test/config/loadWatchesFromDb.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Refactor `loadConfig` to merge yaml + DB**

Replace `src/config/loadConfig.ts` with:

```ts
import { InvalidConfigError } from "@domain/errors";
import { type Config, ConfigSchema } from "@domain/schemas/Config";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import pg from "pg";

export async function loadConfig(path: string, opts?: { pool?: pg.Pool }): Promise<Config> {
  const raw = await Bun.file(path).text();
  const expanded = expandEnvVars(raw);
  const parsed = Bun.YAML.parse(expanded) as Record<string, unknown>;

  // The watches[] array is now sourced from Postgres; ignore any YAML watches.
  const databaseUrl = (parsed.database as { url: string } | undefined)?.url;
  const pool = opts?.pool ?? new pg.Pool({ connectionString: databaseUrl });
  const watches = await loadWatchesFromDb(pool);
  if (!opts?.pool) await pool.end();

  const merged = { ...parsed, watches };
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new InvalidConfigError(`Configuration invalide:\n${issues}`);
  }
  return result.data;
}

export function expandEnvVars(input: string): string {
  return input.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new InvalidConfigError(`Variable d'environnement manquante: ${name}`);
    }
    return v;
  });
}
```

- [ ] **Step 6: Verify existing test suite still passes**

Run: `bun test test/config test/adapters/persistence test/integration`
Expected: all green. The yaml `watches:` array is silently ignored — the new `watches[]` comes from DB (empty in tests that didn't seed it, which is fine since no test relied on yaml-sourced watches).

- [ ] **Step 7: Commit**

```bash
git add src/config/loadWatchesFromDb.ts src/config/loadConfig.ts test/config/loadWatchesFromDb.test.ts
git commit -m "feat(config): read watches[] from Postgres, keep YAML for global infra

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Extract `bootstrapWatch` helper

**Files:**
- Create: `src/config/bootstrapWatch.ts`
- Modify: `src/cli/bootstrap-schedules.ts` (becomes thin wrapper)
- Test: `test/config/bootstrapWatch.test.ts`

- [ ] **Step 1: Write the failing test (mocked Temporal client)**

Create `test/config/bootstrapWatch.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { bootstrapWatch } from "@config/bootstrapWatch";
import type { WatchConfig } from "@domain/schemas/Config";

const watch: WatchConfig = {
  id: "btc-1h", enabled: true,
  asset: { symbol: "BTCUSDT", source: "binance" },
  timeframes: { primary: "1h", higher: [] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50, score_initial: 25,
    score_threshold_finalizer: 80, score_threshold_dead: 10,
    invalidation_policy: "strict", score_max: 100,
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6", max_tokens: 2000 },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5", max_tokens: 2000 },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
  },
  notifications: {
    telegram_chat_id: "123", notify_on: ["confirmed"],
    include_chart_image: true, include_reasoning: true,
  },
  pre_filter: { enabled: true, mode: "lenient", thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 } },
  deduplication: { similar_setup_window_candles: 5, similar_price_tolerance_pct: 0.5 },
  optimization: { reviewer_skip_when_detector_corroborated: true },
  history_compaction: { max_raw_events_in_context: 40, summarize_after_age_hours: 48 },
  budget: { pause_on_budget_exceeded: true },
} as WatchConfig;

describe("bootstrapWatch", () => {
  test("starts both workflows and creates the schedule", async () => {
    const startMock = mock(async () => undefined);
    const scheduleCreate = mock(async () => undefined);
    const describe = mock(async () => { throw Object.assign(new Error("not found"), { name: "ScheduleNotFoundError" }); });

    const fakeClient = {
      workflow: { start: startMock },
      schedule: {
        getHandle: () => ({ describe, update: mock(async () => undefined) }),
        create: scheduleCreate,
      },
    } as unknown as Parameters<typeof bootstrapWatch>[1]["client"];

    await bootstrapWatch(watch, {
      client: fakeClient,
      taskQueues: { scheduler: "scheduler", analysis: "analysis", notifications: "notifications" },
    });

    expect(startMock.mock.calls.length).toBe(2);  // SchedulerWorkflow + PriceMonitorWorkflow
    expect(scheduleCreate).toHaveBeenCalledTimes(1);
  });

  test("is idempotent — already-running workflows are tolerated", async () => {
    const startMock = mock(async () => { throw new Error("Workflow already started"); });
    const fakeClient = {
      workflow: { start: startMock },
      schedule: {
        getHandle: () => ({
          describe: mock(async () => ({ spec: {} })),
          update: mock(async () => undefined),
        }),
        create: mock(async () => undefined),
      },
    } as unknown as Parameters<typeof bootstrapWatch>[1]["client"];

    await expect(
      bootstrapWatch(watch, {
        client: fakeClient,
        taskQueues: { scheduler: "scheduler", analysis: "analysis", notifications: "notifications" },
      })
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test (expect failure — module missing)**

Run: `bun test test/config/bootstrapWatch.test.ts`
Expected: FAIL with `Cannot find module '@config/bootstrapWatch'`.

- [ ] **Step 3: Create `bootstrapWatch.ts`**

Create `src/config/bootstrapWatch.ts`:

```ts
import { cronForTimeframe } from "@domain/services/cronForTimeframe";
import type { WatchConfig } from "@domain/schemas/Config";
import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import { ScheduleNotFoundError } from "@temporalio/client";
import { pickPriceFeedAdapter } from "@workflows/price-monitor/activities";
import { priceMonitorWorkflowId } from "@workflows/price-monitor/priceMonitorWorkflow";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

export type TaskQueues = {
  scheduler: string;
  analysis: string;
  notifications: string;
};

export type BootstrapDeps = { client: Client; taskQueues: TaskQueues };

const log = getLogger({ component: "bootstrap-watch" });

export async function bootstrapWatch(watch: WatchConfig, deps: BootstrapDeps): Promise<void> {
  const { client, taskQueues } = deps;
  const watchLog = log.child({ watchId: watch.id });
  const cron = watch.schedule.detector_cron ?? cronForTimeframe(watch.timeframes.primary);

  await client.workflow
    .start("schedulerWorkflow", {
      args: [{ watchId: watch.id, analysisTaskQueue: taskQueues.analysis }],
      workflowId: schedulerWorkflowId(watch.id),
      taskQueue: taskQueues.scheduler,
    })
    .catch((err: Error) => {
      if (!/already running|already started|alreadystarted/i.test(err.message)) throw err;
    });

  await client.workflow
    .start("priceMonitorWorkflow", {
      args: [{ watchId: watch.id, adapter: pickPriceFeedAdapter(watch.asset.source) }],
      workflowId: priceMonitorWorkflowId(watch.id),
      taskQueue: taskQueues.scheduler,
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
      spec: { cronExpressions: [cron], timezone: watch.schedule.timezone ?? "UTC" },
    }));
    watchLog.info({ cron }, "updated schedule");
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) {
      await client.schedule.create({
        scheduleId,
        spec: { cronExpressions: [cron], timezone: watch.schedule.timezone ?? "UTC" },
        action: {
          type: "startWorkflow",
          workflowType: "tickStarterWorkflow",
          workflowId: `tick-starter-${watch.id}`,
          taskQueue: taskQueues.scheduler,
          args: [{ watchId: watch.id }],
        },
      });
      watchLog.info({ cron }, "created schedule");
    } else throw err;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `bun test test/config/bootstrapWatch.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Refactor `bootstrap-schedules.ts` CLI to use the helper**

Replace `src/cli/bootstrap-schedules.ts` with:

```ts
import { bootstrapWatch } from "@config/bootstrapWatch";
import { loadConfig } from "@config/loadConfig";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";

const log = getLogger({ component: "bootstrap-schedules" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const config = await loadConfig(configPath);
const connection = await Connection.connect({ address: config.temporal.address });
const client = new Client({ connection, namespace: config.temporal.namespace });

for (const watch of config.watches.filter((w) => w.enabled)) {
  await bootstrapWatch(watch, { client, taskQueues: config.temporal.task_queues });
}

log.info({ count: config.watches.filter((w) => w.enabled).length }, "done");
process.exit(0);
```

- [ ] **Step 6: Verify integration tests still pass**

Run: `bun test test/integration`
Expected: green (the CLI path is structurally equivalent).

- [ ] **Step 7: Commit**

```bash
git add src/config/bootstrapWatch.ts src/cli/bootstrap-schedules.ts test/config/bootstrapWatch.test.ts
git commit -m "refactor(config): extract bootstrapWatch helper from CLI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Extract `applyReload` helper

**Files:**
- Create: `src/config/applyReload.ts`
- Modify: `src/cli/reload-config.ts`
- Test: `test/config/applyReload.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config/applyReload.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { applyReload } from "@config/applyReload";
import type { WatchConfig } from "@domain/schemas/Config";

const baseWatch = (overrides: Partial<WatchConfig> = {}): WatchConfig => ({
  id: "btc-1h", enabled: true,
  asset: { symbol: "BTCUSDT", source: "binance" },
  timeframes: { primary: "1h", higher: [] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50, score_initial: 25,
    score_threshold_finalizer: 80, score_threshold_dead: 10,
    invalidation_policy: "strict", score_max: 100,
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6", max_tokens: 2000 },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5", max_tokens: 2000 },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
  },
  notifications: {
    telegram_chat_id: "123", notify_on: ["confirmed"],
    include_chart_image: true, include_reasoning: true,
  },
  pre_filter: { enabled: true, mode: "lenient", thresholds: { atr_ratio_min: 1.3, volume_spike_min: 1.5, rsi_extreme_distance: 25 } },
  deduplication: { similar_setup_window_candles: 5, similar_price_tolerance_pct: 0.5 },
  optimization: { reviewer_skip_when_detector_corroborated: true },
  history_compaction: { max_raw_events_in_context: 40, summarize_after_age_hours: 48 },
  budget: { pause_on_budget_exceeded: true },
  ...overrides,
} as WatchConfig);

describe("applyReload", () => {
  test("signals reloadConfig when only non-cron fields change", async () => {
    const signal = mock(async () => undefined);
    const update = mock(async () => undefined);
    const fakeClient = {
      workflow: { getHandle: () => ({ signal }) },
      schedule: { getHandle: () => ({ update }) },
    } as unknown as Parameters<typeof applyReload>[0]["client"];

    const old = baseWatch();
    const next = baseWatch({ setup_lifecycle: { ...old.setup_lifecycle, score_threshold_finalizer: 75 } });

    await applyReload({ client: fakeClient, watch: next, previous: old });

    expect(signal).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  test("updates the schedule when detector_cron changes", async () => {
    const signal = mock(async () => undefined);
    const update = mock(async () => undefined);
    const fakeClient = {
      workflow: { getHandle: () => ({ signal }) },
      schedule: { getHandle: () => ({ update }) },
    } as unknown as Parameters<typeof applyReload>[0]["client"];

    const old = baseWatch();
    const next = baseWatch({ schedule: { detector_cron: "*/30 * * * *", timezone: "UTC" } });

    await applyReload({ client: fakeClient, watch: next, previous: old });

    expect(update).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/config/applyReload.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `applyReload`**

Create `src/config/applyReload.ts`:

```ts
import { cronForTimeframe } from "@domain/services/cronForTimeframe";
import type { WatchConfig } from "@domain/schemas/Config";
import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const log = getLogger({ component: "apply-reload" });

export type ApplyReloadInput = {
  client: Client;
  watch: WatchConfig;
  previous: WatchConfig | null;
};

export async function applyReload(input: ApplyReloadInput): Promise<void> {
  const { client, watch, previous } = input;
  const watchLog = log.child({ watchId: watch.id });

  const newCron = watch.schedule.detector_cron ?? cronForTimeframe(watch.timeframes.primary);
  const oldCron = previous
    ? previous.schedule.detector_cron ?? cronForTimeframe(previous.timeframes.primary)
    : null;

  if (oldCron !== newCron) {
    const handle = client.schedule.getHandle(`tick-${watch.id}`);
    await handle.update((current) => ({
      ...current,
      spec: { cronExpressions: [newCron], timezone: watch.schedule.timezone ?? "UTC" },
    }));
    watchLog.info({ oldCron, newCron }, "updated schedule cron");
  }

  await client.workflow
    .getHandle(schedulerWorkflowId(watch.id))
    .signal("reloadConfig", watch);
  watchLog.info("sent reloadConfig signal");
}
```

- [ ] **Step 4: Run the test**

Run: `bun test test/config/applyReload.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Refactor `reload-config.ts` CLI**

Replace `src/cli/reload-config.ts`:

```ts
import { applyReload } from "@config/applyReload";
import { loadConfig } from "@config/loadConfig";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";

const log = getLogger({ component: "reload-config" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const dryRun = process.argv.includes("--dry-run");

const config = await loadConfig(configPath);
log.info({ count: config.watches.length }, "loaded watches");

if (dryRun) {
  log.info("--dry-run, exiting before applying");
  process.exit(0);
}

const connection = await Connection.connect({ address: config.temporal.address });
const client = new Client({ connection, namespace: config.temporal.namespace });

for (const watch of config.watches.filter((w) => w.enabled)) {
  try {
    await applyReload({ client, watch, previous: null });
  } catch (err) {
    log.warn({ watchId: watch.id, err: (err as Error).message }, "could not reload");
  }
}

log.info("done");
process.exit(0);
```

- [ ] **Step 6: Commit**

```bash
git add src/config/applyReload.ts src/cli/reload-config.ts test/config/applyReload.test.ts
git commit -m "refactor(config): extract applyReload helper from CLI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Extract `tearDownWatch` helper

**Files:**
- Create: `src/config/tearDownWatch.ts`
- Test: `test/config/tearDownWatch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config/tearDownWatch.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { tearDownWatch } from "@config/tearDownWatch";

describe("tearDownWatch", () => {
  test("deletes schedule and terminates both workflows", async () => {
    const scheduleDelete = mock(async () => undefined);
    const wfTerminate = mock(async () => undefined);
    const fakeClient = {
      workflow: { getHandle: () => ({ terminate: wfTerminate }) },
      schedule: { getHandle: () => ({ delete: scheduleDelete }) },
    } as unknown as Parameters<typeof tearDownWatch>[0]["client"];

    await tearDownWatch({ client: fakeClient, watchId: "btc-1h" });

    expect(scheduleDelete).toHaveBeenCalledTimes(1);
    expect(wfTerminate).toHaveBeenCalledTimes(2);  // SchedulerWorkflow + PriceMonitorWorkflow
  });

  test("is idempotent — already-deleted entities are tolerated", async () => {
    const fakeClient = {
      workflow: { getHandle: () => ({ terminate: mock(async () => { throw new Error("Workflow not found"); }) }) },
      schedule: { getHandle: () => ({ delete: mock(async () => { throw new Error("schedule not found"); }) }) },
    } as unknown as Parameters<typeof tearDownWatch>[0]["client"];

    await expect(tearDownWatch({ client: fakeClient, watchId: "ghost" })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/config/tearDownWatch.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `tearDownWatch`**

Create `src/config/tearDownWatch.ts`:

```ts
import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import { priceMonitorWorkflowId } from "@workflows/price-monitor/priceMonitorWorkflow";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const log = getLogger({ component: "teardown-watch" });

export async function tearDownWatch(input: { client: Client; watchId: string }): Promise<void> {
  const { client, watchId } = input;
  const watchLog = log.child({ watchId });

  const ignoreNotFound = (err: Error) => {
    if (/not found/i.test(err.message)) {
      watchLog.info({ msg: err.message }, "tear-down: target absent (idempotent)");
      return;
    }
    throw err;
  };

  await client.schedule
    .getHandle(`tick-${watchId}`)
    .delete()
    .catch(ignoreNotFound);

  await client.workflow
    .getHandle(schedulerWorkflowId(watchId))
    .terminate("watch deleted via UI")
    .catch(ignoreNotFound);

  await client.workflow
    .getHandle(priceMonitorWorkflowId(watchId))
    .terminate("watch deleted via UI")
    .catch(ignoreNotFound);

  watchLog.info("tear-down complete");
}
```

- [ ] **Step 4: Run the test**

Run: `bun test test/config/tearDownWatch.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/config/tearDownWatch.ts test/config/tearDownWatch.test.ts
git commit -m "feat(config): add tearDownWatch helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Extract `watchOps` helpers (pause / resume / forceTick / killSetup)

**Files:**
- Create: `src/config/watchOps.ts`
- Modify: `src/cli/pause-watch.ts`, `src/cli/force-tick.ts`, `src/cli/kill-setup.ts`
- Test: `test/config/watchOps.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config/watchOps.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { forceTick, killSetup, pauseWatch, resumeWatch } from "@config/watchOps";

const fake = () => {
  const signal = mock(async () => undefined);
  const trigger = mock(async () => undefined);
  const pause = mock(async () => undefined);
  const unpause = mock(async () => undefined);
  const client = {
    workflow: { getHandle: () => ({ signal }) },
    schedule: { getHandle: () => ({ trigger, pause, unpause }) },
  } as unknown as Parameters<typeof pauseWatch>[0]["client"];
  return { client, signal, trigger, pause, unpause };
};

describe("watchOps", () => {
  test("pauseWatch pauses the schedule", async () => {
    const { client, pause } = fake();
    await pauseWatch({ client, watchId: "btc-1h" });
    expect(pause).toHaveBeenCalledTimes(1);
  });

  test("resumeWatch unpauses the schedule", async () => {
    const { client, unpause } = fake();
    await resumeWatch({ client, watchId: "btc-1h" });
    expect(unpause).toHaveBeenCalledTimes(1);
  });

  test("forceTick triggers the schedule immediately", async () => {
    const { client, trigger } = fake();
    await forceTick({ client, watchId: "btc-1h" });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  test("killSetup signals the SetupWorkflow", async () => {
    const { client, signal } = fake();
    await killSetup({ client, setupId: "abc-123", reason: "manual" });
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal.mock.calls[0]![0]).toBe("close");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/config/watchOps.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `watchOps.ts`**

Create `src/config/watchOps.ts`:

```ts
import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import { schedulerWorkflowId } from "@workflows/scheduler/schedulerWorkflow";

const log = getLogger({ component: "watch-ops" });

export async function pauseWatch(input: { client: Client; watchId: string }): Promise<void> {
  await input.client.schedule.getHandle(`tick-${input.watchId}`).pause("paused via UI");
  log.info({ watchId: input.watchId }, "paused");
}

export async function resumeWatch(input: { client: Client; watchId: string }): Promise<void> {
  await input.client.schedule.getHandle(`tick-${input.watchId}`).unpause("resumed via UI");
  log.info({ watchId: input.watchId }, "resumed");
}

export async function forceTick(input: { client: Client; watchId: string }): Promise<void> {
  await input.client.schedule.getHandle(`tick-${input.watchId}`).trigger();
  log.info({ watchId: input.watchId }, "force-tick triggered");
}

export async function killSetup(input: { client: Client; setupId: string; reason: string }): Promise<void> {
  await input.client.workflow
    .getHandle(`setup-${input.setupId}`)
    .signal("close", { reason: input.reason });
  log.info({ setupId: input.setupId, reason: input.reason }, "kill signal sent");
}
```

- [ ] **Step 4: Run the test**

Run: `bun test test/config/watchOps.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Refactor the three CLIs**

Replace `src/cli/pause-watch.ts`:

```ts
import { pauseWatch, resumeWatch } from "@config/watchOps";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";

const log = getLogger({ component: "pause-watch" });

const watchId = process.argv[2];
const action = process.argv[3] ?? "pause";
if (!watchId || !["pause", "resume"].includes(action)) {
  log.error("Usage: pause-watch <watch-id> [pause|resume]");
  process.exit(1);
}

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
});
const client = new Client({ connection });

if (action === "pause") await pauseWatch({ client, watchId });
else await resumeWatch({ client, watchId });

process.exit(0);
```

Replace `src/cli/force-tick.ts`:

```ts
import { forceTick } from "@config/watchOps";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";

const log = getLogger({ component: "force-tick" });

const watchId = process.argv[2];
if (!watchId) {
  log.error("Usage: force-tick <watch-id>");
  process.exit(1);
}

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
});
const client = new Client({ connection });
await forceTick({ client, watchId });
process.exit(0);
```

Replace `src/cli/kill-setup.ts`:

```ts
import { killSetup } from "@config/watchOps";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";

const log = getLogger({ component: "kill-setup" });

const setupId = process.argv[2];
const reason = process.argv.find((a) => a.startsWith("--reason="))?.slice(9) ?? "manual_close";
if (!setupId) {
  log.error("Usage: kill-setup <setup-id> [--reason=...]");
  process.exit(1);
}

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
});
const client = new Client({ connection });
await killSetup({ client, setupId, reason });
process.exit(0);
```

- [ ] **Step 6: Commit**

```bash
git add src/config/watchOps.ts src/cli/pause-watch.ts src/cli/force-tick.ts src/cli/kill-setup.ts test/config/watchOps.test.ts
git commit -m "refactor(config): extract pause/resume/forceTick/killSetup into watchOps

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Add `seed-watches-from-yaml` CLI

**Files:**
- Create: `src/cli/seed-watches-from-yaml.ts`
- Test: `test/cli/seedWatchesFromYaml.test.ts`

- [ ] **Step 1: Write the test**

Create `test/cli/seedWatchesFromYaml.test.ts`:

```ts
import { startTestPostgres } from "@test-helpers/postgres";
import { watchConfigs } from "@adapters/persistence/schema";
import { seedWatchesFromYaml } from "@cli/seedWatchesFromYaml.lib";
import { describe, expect, test } from "bun:test";

const yaml = `
version: 1
market_data:
  binance: { base_url: "https://api.binance.com" }
llm_providers:
  claude_max:
    type: claude-agent-sdk
    workspace_dir: /data/claude-workspace
    fallback: null
artifacts:
  type: filesystem
  base_dir: /data/artifacts
notifications:
  telegram: { bot_token: "x", default_chat_id: "1" }
database: { url: "postgres://x" }
temporal: { address: "localhost:7233" }
watches:
  - id: btc-1h
    enabled: true
    asset: { symbol: BTCUSDT, source: binance }
    timeframes: { primary: 1h, higher: [4h] }
    schedule: { timezone: UTC }
    candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 }
    setup_lifecycle:
      ttl_candles: 50
      score_initial: 25
      score_threshold_finalizer: 80
      score_threshold_dead: 10
    analyzers:
      detector:  { provider: claude_max, model: claude-sonnet-4-6 }
      reviewer:  { provider: claude_max, model: claude-haiku-4-5 }
      finalizer: { provider: claude_max, model: claude-opus-4-7 }
    notifications:
      telegram_chat_id: "123"
      notify_on: [confirmed]
`;

describe("seedWatchesFromYaml", () => {
  test("seeds new watches and skips existing ones", async () => {
    const tp = await startTestPostgres();
    try {
      const inserted1 = await seedWatchesFromYaml({ pool: tp.pool, yamlText: yaml });
      expect(inserted1).toBe(1);

      const inserted2 = await seedWatchesFromYaml({ pool: tp.pool, yamlText: yaml });
      expect(inserted2).toBe(0);  // idempotent

      const rows = await tp.db.select().from(watchConfigs);
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toBe("btc-1h");
    } finally {
      await tp.cleanup();
    }
  });
});
```

- [ ] **Step 2: Add `@cli/*` alias to `tsconfig.json`**

Add to `tsconfig.json` `paths`:

```json
"@cli/*": ["./src/cli/*"]
```

- [ ] **Step 3: Implement the seeding library**

Create `src/cli/seedWatchesFromYaml.lib.ts`:

```ts
import { watchConfigs, watchConfigRevisions } from "@adapters/persistence/schema";
import { WatchSchema } from "@domain/schemas/Config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

export async function seedWatchesFromYaml(input: { pool: pg.Pool; yamlText: string }): Promise<number> {
  const db = drizzle(input.pool);
  const parsed = Bun.YAML.parse(input.yamlText) as { watches?: unknown[] };
  const watchesRaw = parsed.watches ?? [];

  let inserted = 0;
  for (const raw of watchesRaw) {
    const watch = WatchSchema.parse(raw);
    const [existing] = await db.select().from(watchConfigs).where(eq(watchConfigs.id, watch.id));
    if (existing) continue;

    await db.transaction(async (tx) => {
      await tx.insert(watchConfigs).values({
        id: watch.id, enabled: watch.enabled, config: watch as unknown, version: 1,
      });
      await tx.insert(watchConfigRevisions).values({
        watchId: watch.id, config: watch as unknown, version: 1, appliedBy: "seed",
      });
    });
    inserted += 1;
  }
  return inserted;
}
```

- [ ] **Step 4: Implement the CLI thin wrapper**

Create `src/cli/seed-watches-from-yaml.ts`:

```ts
import { seedWatchesFromYaml } from "@cli/seedWatchesFromYaml.lib";
import { getLogger } from "@observability/logger";
import pg from "pg";

const log = getLogger({ component: "seed-watches-from-yaml" });

const path = process.argv[2] ?? "config/watches.yaml";
const url = process.env.DATABASE_URL;
if (!url) {
  log.error("DATABASE_URL not set");
  process.exit(1);
}

const yamlText = await Bun.file(path).text();
const pool = new pg.Pool({ connectionString: url });

try {
  const inserted = await seedWatchesFromYaml({ pool, yamlText });
  log.info({ inserted, path }, "seed complete");
} finally {
  await pool.end();
}
process.exit(0);
```

- [ ] **Step 5: Run the test**

Run: `bun test test/cli/seedWatchesFromYaml.test.ts`
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add src/cli/seedWatchesFromYaml.lib.ts src/cli/seed-watches-from-yaml.ts test/cli/seedWatchesFromYaml.test.ts tsconfig.json
git commit -m "feat(cli): add seed-watches-from-yaml one-shot migration tool

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 1 — tf-web backend foundation

### Task 8: Project scaffolding (`@client/*` alias, base directories, deps)

**Files:**
- Modify: `tsconfig.json`, `package.json`
- Create: `src/client/server.ts` (skeleton), `src/client/lib/logger.ts`, `src/client/lib/db.ts`

- [ ] **Step 1: Add `@client/*` to `tsconfig.json` paths**

Edit `tsconfig.json` `paths` section (keep existing entries; add):

```json
"@client/*": ["./src/client/*"]
```

- [ ] **Step 2: Add backend frontend deps via Bun**

Run:

```bash
bun add @temporalio/client@^1.16.1
bun add -d @happy-dom/global-registrator @testing-library/react @types/react @types/react-dom
bun add react@^19 react-dom@^19 react-router-dom@^7 @tanstack/react-query@^5
bun add react-hook-form @hookform/resolvers date-fns
```

Note: `@temporalio/client` is already in deps but pin the same version as workers.

- [ ] **Step 3: Create the logger child helper**

Create `src/client/lib/logger.ts`:

```ts
import { getLogger as base } from "@observability/logger";

export const webLogger = base({ component: "tf-web" });

export function childLogger(extra: Record<string, unknown>) {
  return webLogger.child(extra);
}
```

- [ ] **Step 4: Create the DB connection helper**

Create `src/client/lib/db.ts`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for tf-web");

export const pool = new pg.Pool({
  connectionString: url,
  max: Number(process.env.TF_WEB_PG_POOL_SIZE ?? 10),
});

export const db = drizzle(pool);
```

- [ ] **Step 5: Create the minimal server skeleton (will grow in Task 11)**

Create `src/client/server.ts`:

```ts
import { webLogger } from "@client/lib/logger";

const port = Number(process.env.WEB_PORT ?? 8084);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ component: "tf-web", status: "ok", uptimeMs: process.uptime() * 1000 });
    }
    return new Response("not implemented", { status: 501 });
  },
});

webLogger.info({ port: server.port }, "tf-web listening");
```

- [ ] **Step 6: Smoke-run the skeleton**

Run (in another terminal): `WEB_PORT=8084 DATABASE_URL=postgres://trading_flow:test@localhost:5432/trading_flow bun run src/client/server.ts &`

Then: `curl -s http://localhost:8084/health`
Expected: `{"component":"tf-web","status":"ok","uptimeMs":...}`

Stop with `kill %1`.

- [ ] **Step 7: Add a `worker:web` script to `package.json`**

Edit `package.json` `scripts`:

```json
"worker:web": "bun run src/client/server.ts"
```

- [ ] **Step 8: Commit**

```bash
git add tsconfig.json package.json bun.lock src/client/
git commit -m "feat(tf-web): scaffold Bun.serve skeleton with /health endpoint

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Temporal client helper

**Files:**
- Create: `src/client/lib/temporal.ts`

- [ ] **Step 1: Implement the singleton Temporal client**

Create `src/client/lib/temporal.ts`:

```ts
import { Client, Connection } from "@temporalio/client";

let cached: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (cached) return cached;
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const connection = await Connection.connect({ address });
  cached = new Client({ connection, namespace });
  return cached;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/lib/temporal.ts
git commit -m "feat(tf-web): add cached Temporal client helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `safeHandler` wrapper + base API structure

**Files:**
- Create: `src/client/api/safeHandler.ts`, `src/client/api/health.ts`

- [ ] **Step 1: Write the test**

Create `test/client/api/safeHandler.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { safeHandler } from "@client/api/safeHandler";

describe("safeHandler", () => {
  test("passes through successful responses", async () => {
    const handler = safeHandler(async () => Response.json({ ok: true }));
    const res = await handler(new Request("http://x/y"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("returns 500 on uncaught exceptions", async () => {
    const handler = safeHandler(async () => { throw new Error("boom"); });
    const res = await handler(new Request("http://x/y"));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("boom");
  });

  test("returns 400 on ZodError", async () => {
    const { z } = await import("zod");
    const handler = safeHandler(async () => {
      z.object({ a: z.string() }).parse({ a: 123 });
      return Response.json({});
    });
    const res = await handler(new Request("http://x/y"));
    expect(res.status).toBe(400);
  });

  test("returns 409 on ConflictError", async () => {
    const { ConflictError } = await import("@client/api/safeHandler");
    const handler = safeHandler(async () => { throw new ConflictError("version mismatch"); });
    const res = await handler(new Request("http://x/y"));
    expect(res.status).toBe(409);
  });

  test("returns 404 on NotFoundError", async () => {
    const { NotFoundError } = await import("@client/api/safeHandler");
    const handler = safeHandler(async () => { throw new NotFoundError("missing"); });
    const res = await handler(new Request("http://x/y"));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Implement `safeHandler.ts`**

Create `src/client/api/safeHandler.ts`:

```ts
import { childLogger } from "@client/lib/logger";
import { ZodError } from "zod";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class ValidationError extends Error {}

type Handler = (req: Request, params?: Record<string, string>) => Promise<Response>;

export function safeHandler(handler: Handler): Handler {
  return async (req, params) => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    const log = childLogger({ requestId, method: req.method, url: req.url });
    try {
      const res = await handler(req, params);
      log.info({ status: res.status }, "request completed");
      return res;
    } catch (err) {
      if (err instanceof ZodError) {
        return Response.json(
          { error: "validation", issues: err.issues },
          { status: 400, headers: { "x-request-id": requestId } }
        );
      }
      if (err instanceof ConflictError) {
        return Response.json({ error: err.message }, { status: 409, headers: { "x-request-id": requestId } });
      }
      if (err instanceof NotFoundError) {
        return Response.json({ error: err.message }, { status: 404, headers: { "x-request-id": requestId } });
      }
      if (err instanceof ValidationError) {
        return Response.json({ error: err.message }, { status: 400, headers: { "x-request-id": requestId } });
      }
      log.error({ err: (err as Error).message, stack: (err as Error).stack }, "unhandled error");
      return Response.json(
        { error: (err as Error).message ?? "internal error" },
        { status: 500, headers: { "x-request-id": requestId } }
      );
    }
  };
}
```

- [ ] **Step 3: Implement `/health` route module**

Create `src/client/api/health.ts`:

```ts
import { safeHandler } from "@client/api/safeHandler";

const startedAt = new Date();

export const health = safeHandler(async () =>
  Response.json({
    component: "tf-web",
    status: "ok",
    startedAt: startedAt.toISOString(),
    uptimeMs: Date.now() - startedAt.getTime(),
  })
);
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/client/api/safeHandler.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/api/safeHandler.ts src/client/api/health.ts test/client/api/safeHandler.test.ts
git commit -m "feat(tf-web): add safeHandler wrapper + health route

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Wire `/health` into `Bun.serve` routes

**Files:**
- Modify: `src/client/server.ts`

- [ ] **Step 1: Update `server.ts` to use the routes object pattern**

Replace `src/client/server.ts`:

```ts
import { health } from "@client/api/health";
import { webLogger } from "@client/lib/logger";

const port = Number(process.env.WEB_PORT ?? 8084);

const server = Bun.serve({
  port,
  routes: {
    "/health": { GET: health },
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

webLogger.info({ port: server.port }, "tf-web listening");
```

- [ ] **Step 2: Smoke-test**

Run in another terminal: `WEB_PORT=8084 DATABASE_URL=postgres://trading_flow:test@localhost:5432/trading_flow bun run src/client/server.ts &`
Then: `curl -i http://localhost:8084/health`
Expected: 200 with JSON `{ component: "tf-web", status: "ok", ... }`

`curl -i http://localhost:8084/random`
Expected: 404 with body `not found`.

Stop with `kill %1`.

- [ ] **Step 3: Commit**

```bash
git add src/client/server.ts
git commit -m "feat(tf-web): wire /health into Bun.serve routes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Backend API: watches CRUD

### Task 12: `watchConfigService` (create / update / delete with concurrency)

**Files:**
- Create: `src/client/lib/watchConfigService.ts`
- Test: `test/client/lib/watchConfigService.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/client/lib/watchConfigService.test.ts`:

```ts
import { startTestPostgres } from "@test-helpers/postgres";
import { watchConfigs, watchConfigRevisions } from "@adapters/persistence/schema";
import { ConflictError } from "@client/api/safeHandler";
import {
  createWatchConfig, updateWatchConfig, softDeleteWatchConfig,
} from "@client/lib/watchConfigService";
import { WatchSchema, type WatchConfig } from "@domain/schemas/Config";
import { eq } from "drizzle-orm";
import { describe, expect, mock, test } from "bun:test";

const fullWatch = (id = "btc-1h"): WatchConfig => WatchSchema.parse({
  id, enabled: true,
  asset: { symbol: "BTCUSDT", source: "binance" },
  timeframes: { primary: "1h", higher: ["4h"] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50, score_initial: 25,
    score_threshold_finalizer: 80, score_threshold_dead: 10,
    invalidation_policy: "strict",
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6" },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5" },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7" },
  },
  notifications: { telegram_chat_id: "123", notify_on: ["confirmed"] },
});

const noopHooks = {
  bootstrap: mock(async () => undefined),
  applyReload: mock(async () => undefined),
  tearDown: mock(async () => undefined),
};

describe("watchConfigService", () => {
  test("create inserts a config + revision and calls bootstrap", async () => {
    const tp = await startTestPostgres();
    try {
      const watch = fullWatch();
      const hooks = { ...noopHooks, bootstrap: mock(async () => undefined) };
      const created = await createWatchConfig({ db: tp.db, hooks, input: watch });

      expect(created.id).toBe("btc-1h");
      expect(created.version).toBe(1);
      const rev = await tp.db.select().from(watchConfigRevisions);
      expect(rev.length).toBe(1);
      expect(hooks.bootstrap).toHaveBeenCalledTimes(1);
    } finally { await tp.cleanup(); }
  });

  test("create rejects duplicate id", async () => {
    const tp = await startTestPostgres();
    try {
      const watch = fullWatch();
      await createWatchConfig({ db: tp.db, hooks: noopHooks, input: watch });
      await expect(
        createWatchConfig({ db: tp.db, hooks: noopHooks, input: watch })
      ).rejects.toThrow(ConflictError);
    } finally { await tp.cleanup(); }
  });

  test("update bumps version when versions match", async () => {
    const tp = await startTestPostgres();
    try {
      const watch = fullWatch();
      const hooks = { ...noopHooks, applyReload: mock(async () => undefined) };
      await createWatchConfig({ db: tp.db, hooks, input: watch });

      const next = { ...watch, enabled: false };
      const updated = await updateWatchConfig({
        db: tp.db, hooks, id: "btc-1h", input: next, expectedVersion: 1,
      });
      expect(updated.version).toBe(2);
      expect(hooks.applyReload).toHaveBeenCalledTimes(1);
    } finally { await tp.cleanup(); }
  });

  test("update fails 409 on stale version", async () => {
    const tp = await startTestPostgres();
    try {
      const watch = fullWatch();
      await createWatchConfig({ db: tp.db, hooks: noopHooks, input: watch });
      await expect(
        updateWatchConfig({
          db: tp.db, hooks: noopHooks, id: "btc-1h", input: watch, expectedVersion: 99,
        })
      ).rejects.toThrow(ConflictError);
    } finally { await tp.cleanup(); }
  });

  test("softDelete sets deletedAt and calls tearDown", async () => {
    const tp = await startTestPostgres();
    try {
      const watch = fullWatch();
      const hooks = { ...noopHooks, tearDown: mock(async () => undefined) };
      await createWatchConfig({ db: tp.db, hooks, input: watch });

      await softDeleteWatchConfig({ db: tp.db, hooks, id: "btc-1h" });

      const [row] = await tp.db.select().from(watchConfigs).where(eq(watchConfigs.id, "btc-1h"));
      expect(row?.deletedAt).not.toBeNull();
      expect(hooks.tearDown).toHaveBeenCalledTimes(1);
    } finally { await tp.cleanup(); }
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test test/client/lib/watchConfigService.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement the service**

Create `src/client/lib/watchConfigService.ts`:

```ts
import { watchConfigs, watchConfigRevisions } from "@adapters/persistence/schema";
import { ConflictError } from "@client/api/safeHandler";
import type { WatchConfig } from "@domain/schemas/Config";
import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

export type WatchConfigHooks = {
  bootstrap: (watch: WatchConfig) => Promise<void>;
  applyReload: (watch: WatchConfig, previous: WatchConfig | null) => Promise<void>;
  tearDown: (watchId: string) => Promise<void>;
};

export type CreateInput = { db: DB; hooks: WatchConfigHooks; input: WatchConfig };
export type UpdateInput = {
  db: DB; hooks: WatchConfigHooks;
  id: string; input: WatchConfig; expectedVersion: number;
};

export type SavedRow = { id: string; enabled: boolean; version: number };

export async function createWatchConfig({ db, hooks, input }: CreateInput): Promise<SavedRow> {
  const [existing] = await db.select().from(watchConfigs).where(eq(watchConfigs.id, input.id));
  if (existing && !existing.deletedAt) {
    throw new ConflictError(`watch ${input.id} already exists`);
  }

  const inserted = await db.transaction(async (tx) => {
    if (existing?.deletedAt) {
      await tx
        .update(watchConfigs)
        .set({
          config: input as unknown,
          enabled: input.enabled,
          version: 1,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(watchConfigs.id, input.id));
    } else {
      await tx.insert(watchConfigs).values({
        id: input.id, enabled: input.enabled, config: input as unknown, version: 1,
      });
    }
    await tx.insert(watchConfigRevisions).values({
      watchId: input.id, config: input as unknown, version: 1, appliedBy: "ui",
    });
    return { id: input.id, enabled: input.enabled, version: 1 };
  });

  await hooks.bootstrap(input);
  return inserted;
}

export async function updateWatchConfig({
  db, hooks, id, input, expectedVersion,
}: UpdateInput): Promise<SavedRow> {
  const result = await db.transaction(async (tx) => {
    const [previous] = await tx.select().from(watchConfigs).where(eq(watchConfigs.id, id));
    if (!previous || previous.deletedAt) return null;

    const updated = await tx
      .update(watchConfigs)
      .set({
        config: input as unknown,
        enabled: input.enabled,
        version: sql`${watchConfigs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(watchConfigs.id, id), eq(watchConfigs.version, expectedVersion)))
      .returning();

    if (updated.length === 0) {
      throw new ConflictError(
        `version mismatch — current=${previous.version}, expected=${expectedVersion}. Reload and retry.`
      );
    }

    await tx.insert(watchConfigRevisions).values({
      watchId: id, config: input as unknown, version: updated[0]!.version, appliedBy: "ui",
    });

    return { previous: previous.config as WatchConfig, current: updated[0]! };
  });

  if (!result) throw new ConflictError(`watch ${id} not found`);

  await hooks.applyReload(input, result.previous);
  return { id, enabled: input.enabled, version: result.current.version };
}

export async function softDeleteWatchConfig({
  db, hooks, id,
}: { db: DB; hooks: WatchConfigHooks; id: string }): Promise<void> {
  await db
    .update(watchConfigs)
    .set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() })
    .where(eq(watchConfigs.id, id));
  await hooks.tearDown(id);
}
```

- [ ] **Step 4: Run the test**

Run: `bun test test/client/lib/watchConfigService.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/lib/watchConfigService.ts test/client/lib/watchConfigService.test.ts
git commit -m "feat(tf-web): watchConfigService — create/update/delete with optimistic concurrency

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: API routes for watches list / get / create

**Files:**
- Create: `src/client/api/watches.ts`
- Test: `test/client/api/watches.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/client/api/watches.test.ts`:

```ts
import { startTestPostgres } from "@test-helpers/postgres";
import { describe, expect, mock, test } from "bun:test";
import { makeWatchesApi } from "@client/api/watches";
import { WatchSchema } from "@domain/schemas/Config";

const validBody = {
  id: "btc-1h", enabled: true,
  asset: { symbol: "BTCUSDT", source: "binance" },
  timeframes: { primary: "1h", higher: ["4h"] },
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50, score_initial: 25,
    score_threshold_finalizer: 80, score_threshold_dead: 10,
    invalidation_policy: "strict",
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6" },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5" },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7" },
  },
  notifications: { telegram_chat_id: "123", notify_on: ["confirmed"] },
};

const hooks = {
  bootstrap: mock(async () => undefined),
  applyReload: mock(async () => undefined),
  tearDown: mock(async () => undefined),
};

describe("watches API", () => {
  test("GET /api/watches returns empty list initially", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeWatchesApi({ db: tp.db, hooks });
      const res = await api.list(new Request("http://x/api/watches"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally { await tp.cleanup(); }
  });

  test("POST /api/watches creates a watch", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeWatchesApi({ db: tp.db, hooks });
      const res = await api.create(
        new Request("http://x/api/watches", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(validBody),
        })
      );
      expect(res.status).toBe(201);
      const body = await res.json() as { id: string; version: number };
      expect(body.id).toBe("btc-1h");
      expect(body.version).toBe(1);
    } finally { await tp.cleanup(); }
  });

  test("POST /api/watches rejects invalid payload with 400", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeWatchesApi({ db: tp.db, hooks });
      const res = await api.create(
        new Request("http://x/api/watches", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "BAD!" }),
        })
      );
      expect(res.status).toBe(400);
    } finally { await tp.cleanup(); }
  });

  test("GET /api/watches/:id returns the config or 404", async () => {
    const tp = await startTestPostgres();
    try {
      const api = makeWatchesApi({ db: tp.db, hooks });
      await api.create(new Request("http://x", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }));
      const ok = await api.get(new Request("http://x"), { id: "btc-1h" });
      expect(ok.status).toBe(200);
      const body = await ok.json() as { config: typeof validBody; version: number };
      expect(body.version).toBe(1);
      expect(WatchSchema.parse(body.config).id).toBe("btc-1h");

      const miss = await api.get(new Request("http://x"), { id: "nope" });
      expect(miss.status).toBe(404);
    } finally { await tp.cleanup(); }
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test test/client/api/watches.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement the API factory**

Create `src/client/api/watches.ts`:

```ts
import { watchConfigs, watchConfigRevisions, watchStates } from "@adapters/persistence/schema";
import { NotFoundError, safeHandler } from "@client/api/safeHandler";
import {
  createWatchConfig, softDeleteWatchConfig, updateWatchConfig,
  type WatchConfigHooks,
} from "@client/lib/watchConfigService";
import { WatchSchema } from "@domain/schemas/Config";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

type DB = ReturnType<typeof drizzle>;

export type WatchesApiDeps = { db: DB; hooks: WatchConfigHooks };

const UpdateBodySchema = z.object({
  config: WatchSchema,
  version: z.number().int().nonnegative(),
});

export function makeWatchesApi(deps: WatchesApiDeps) {
  const { db, hooks } = deps;

  return {
    list: safeHandler(async () => {
      const rows = await db
        .select({
          id: watchConfigs.id, enabled: watchConfigs.enabled,
          version: watchConfigs.version, config: watchConfigs.config,
          createdAt: watchConfigs.createdAt, updatedAt: watchConfigs.updatedAt,
        })
        .from(watchConfigs)
        .where(isNull(watchConfigs.deletedAt));
      return Response.json(rows);
    }),

    get: safeHandler(async (_req, params) => {
      const id = params!.id!;
      const [row] = await db
        .select()
        .from(watchConfigs)
        .where(and(eq(watchConfigs.id, id), isNull(watchConfigs.deletedAt)));
      if (!row) throw new NotFoundError(`watch ${id} not found`);

      const [state] = await db.select().from(watchStates).where(eq(watchStates.watchId, id));

      return Response.json({
        id: row.id, enabled: row.enabled, version: row.version,
        config: row.config, state: state ?? null,
        createdAt: row.createdAt, updatedAt: row.updatedAt,
      });
    }),

    create: safeHandler(async (req) => {
      const body = WatchSchema.parse(await req.json());
      const created = await createWatchConfig({ db, hooks, input: body });
      return Response.json(created, { status: 201 });
    }),

    update: safeHandler(async (req, params) => {
      const id = params!.id!;
      const body = UpdateBodySchema.parse(await req.json());
      if (body.config.id !== id) {
        throw new Error("config.id must match URL param");
      }
      const updated = await updateWatchConfig({
        db, hooks, id, input: body.config, expectedVersion: body.version,
      });
      return Response.json(updated);
    }),

    del: safeHandler(async (_req, params) => {
      const id = params!.id!;
      const [row] = await db.select().from(watchConfigs).where(eq(watchConfigs.id, id));
      if (!row || row.deletedAt) throw new NotFoundError(`watch ${id} not found`);
      await softDeleteWatchConfig({ db, hooks, id });
      return new Response(null, { status: 204 });
    }),

    revisions: safeHandler(async (_req, params) => {
      const id = params!.id!;
      const rows = await db
        .select()
        .from(watchConfigRevisions)
        .where(eq(watchConfigRevisions.watchId, id))
        .orderBy(desc(watchConfigRevisions.appliedAt));
      return Response.json(rows);
    }),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/client/api/watches.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/api/watches.ts test/client/api/watches.test.ts
git commit -m "feat(tf-web): watches API (list/get/create/update/delete/revisions)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Add update / delete tests + wire watches API into server

**Files:**
- Modify: `test/client/api/watches.test.ts` (add 3 cases)
- Modify: `src/client/server.ts`

- [ ] **Step 1: Append update / delete / revisions tests**

Append to `test/client/api/watches.test.ts` inside the describe block:

```ts
test("PUT /api/watches/:id updates and bumps version", async () => {
  const tp = await startTestPostgres();
  try {
    const api = makeWatchesApi({ db: tp.db, hooks });
    await api.create(new Request("http://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }));
    const next = { ...validBody, enabled: false };
    const res = await api.update(
      new Request("http://x", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: next, version: 1 }),
      }),
      { id: "btc-1h" }
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { version: number };
    expect(body.version).toBe(2);
  } finally { await tp.cleanup(); }
});

test("PUT /api/watches/:id with stale version returns 409", async () => {
  const tp = await startTestPostgres();
  try {
    const api = makeWatchesApi({ db: tp.db, hooks });
    await api.create(new Request("http://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }));
    const res = await api.update(
      new Request("http://x", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: validBody, version: 99 }),
      }),
      { id: "btc-1h" }
    );
    expect(res.status).toBe(409);
  } finally { await tp.cleanup(); }
});

test("DELETE /api/watches/:id soft-deletes", async () => {
  const tp = await startTestPostgres();
  try {
    const api = makeWatchesApi({ db: tp.db, hooks });
    await api.create(new Request("http://x", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }));
    const res = await api.del(new Request("http://x"), { id: "btc-1h" });
    expect(res.status).toBe(204);

    const list = await api.list(new Request("http://x"));
    expect(await list.json()).toEqual([]);
  } finally { await tp.cleanup(); }
});
```

- [ ] **Step 2: Wire the watches API into the server**

Replace `src/client/server.ts`:

```ts
import { health } from "@client/api/health";
import { makeWatchesApi } from "@client/api/watches";
import { db } from "@client/lib/db";
import { webLogger } from "@client/lib/logger";
import { getTemporalClient } from "@client/lib/temporal";
import { applyReload } from "@config/applyReload";
import { bootstrapWatch } from "@config/bootstrapWatch";
import { tearDownWatch } from "@config/tearDownWatch";

const port = Number(process.env.WEB_PORT ?? 8084);

const watchesApi = makeWatchesApi({
  db,
  hooks: {
    bootstrap: async (watch) => {
      const client = await getTemporalClient();
      await bootstrapWatch(watch, {
        client,
        taskQueues: { scheduler: "scheduler", analysis: "analysis", notifications: "notifications" },
      });
    },
    applyReload: async (watch, previous) => {
      const client = await getTemporalClient();
      await applyReload({ client, watch, previous });
    },
    tearDown: async (watchId) => {
      const client = await getTemporalClient();
      await tearDownWatch({ client, watchId });
    },
  },
});

const server = Bun.serve({
  port,
  routes: {
    "/health": { GET: health },
    "/api/watches": { GET: watchesApi.list, POST: watchesApi.create },
    "/api/watches/:id": { GET: watchesApi.get, PUT: watchesApi.update, DELETE: watchesApi.del },
    "/api/watches/:id/revisions": { GET: watchesApi.revisions },
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

webLogger.info({ port: server.port }, "tf-web listening");
```

- [ ] **Step 3: Run all watches tests**

Run: `bun test test/client/api/watches.test.ts`
Expected: 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/client/server.ts test/client/api/watches.test.ts
git commit -m "feat(tf-web): wire watches API into Bun.serve routes + version conflict tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Backend API: monitoring (read-only)

### Task 15: Setups list + detail API

**Files:**
- Create: `src/client/api/setups.ts`
- Test: `test/client/api/setups.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/client/api/setups.test.ts`:

```ts
import { startTestPostgres } from "@test-helpers/postgres";
import { setups, events } from "@adapters/persistence/schema";
import { makeSetupsApi } from "@client/api/setups";
import { describe, expect, test } from "bun:test";

const setupRow = (overrides: Partial<typeof setups.$inferInsert> = {}) => ({
  id: crypto.randomUUID(),
  watchId: "btc-1h", asset: "BTCUSDT", timeframe: "1h",
  status: "REVIEWING", currentScore: "55",
  ttlCandles: 50, ttlExpiresAt: new Date(Date.now() + 1e9),
  workflowId: "setup-1", direction: "LONG",
  ...overrides,
});

describe("setups API", () => {
  test("GET /api/setups returns all setups, filtered by watchId", async () => {
    const tp = await startTestPostgres();
    try {
      const a = setupRow({ watchId: "btc-1h" });
      const b = setupRow({ watchId: "eth-4h" });
      await tp.db.insert(setups).values([a, b]);

      const api = makeSetupsApi({ db: tp.db });
      const all = await api.list(new Request("http://x/api/setups"));
      expect((await all.json() as unknown[]).length).toBe(2);

      const filtered = await api.list(new Request("http://x/api/setups?watchId=btc-1h"));
      const items = await filtered.json() as { watchId: string }[];
      expect(items.length).toBe(1);
      expect(items[0]!.watchId).toBe("btc-1h");
    } finally { await tp.cleanup(); }
  });

  test("GET /api/setups/:id returns one or 404", async () => {
    const tp = await startTestPostgres();
    try {
      const row = setupRow();
      await tp.db.insert(setups).values(row);

      const api = makeSetupsApi({ db: tp.db });
      const ok = await api.get(new Request("http://x"), { id: row.id });
      expect(ok.status).toBe(200);

      const miss = await api.get(new Request("http://x"), { id: crypto.randomUUID() });
      expect(miss.status).toBe(404);
    } finally { await tp.cleanup(); }
  });

  test("GET /api/setups/:id/events returns events ordered by sequence", async () => {
    const tp = await startTestPostgres();
    try {
      const row = setupRow();
      await tp.db.insert(setups).values(row);
      await tp.db.insert(events).values([
        {
          setupId: row.id, sequence: 1, stage: "DETECTOR", actor: "detector_v3",
          type: "SetupCreated", scoreAfter: "25",
          statusBefore: "PROPOSED", statusAfter: "REVIEWING",
          payload: { type: "SetupCreated", data: { pattern: "bull-flag", direction: "LONG", keyLevels: { invalidation: 60000 }, initialScore: 25, rawObservation: "x" } } as never,
        },
        {
          setupId: row.id, sequence: 2, stage: "REVIEWER", actor: "reviewer_v3",
          type: "Strengthened", scoreDelta: "10", scoreAfter: "35",
          statusBefore: "REVIEWING", statusAfter: "REVIEWING",
          payload: { type: "Strengthened", data: { reasoning: "x", observations: [], source: "reviewer_full" } } as never,
        },
      ]);

      const api = makeSetupsApi({ db: tp.db });
      const res = await api.events(new Request("http://x"), { id: row.id });
      const items = await res.json() as { sequence: number }[];
      expect(items.map((e) => e.sequence)).toEqual([1, 2]);
    } finally { await tp.cleanup(); }
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test test/client/api/setups.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `setups.ts`**

Create `src/client/api/setups.ts`:

```ts
import { events, setups } from "@adapters/persistence/schema";
import { NotFoundError, safeHandler } from "@client/api/safeHandler";
import { and, asc, desc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

export type SetupsApiDeps = { db: DB };

export function makeSetupsApi({ db }: SetupsApiDeps) {
  return {
    list: safeHandler(async (req) => {
      const url = new URL(req.url);
      const watchId = url.searchParams.get("watchId");
      const status = url.searchParams.get("status");
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 200));

      const filters = [];
      if (watchId) filters.push(eq(setups.watchId, watchId));
      if (status) filters.push(eq(setups.status, status));

      const rows = await db
        .select()
        .from(setups)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(setups.updatedAt))
        .limit(limit);

      return Response.json(rows);
    }),

    get: safeHandler(async (_req, params) => {
      const id = params!.id!;
      const [row] = await db.select().from(setups).where(eq(setups.id, id));
      if (!row) throw new NotFoundError(`setup ${id} not found`);
      return Response.json(row);
    }),

    events: safeHandler(async (_req, params) => {
      const id = params!.id!;
      const rows = await db
        .select()
        .from(events)
        .where(eq(events.setupId, id))
        .orderBy(asc(events.sequence));
      return Response.json(rows);
    }),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/client/api/setups.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Wire into `server.ts`**

Add to the imports in `src/client/server.ts`:

```ts
import { makeSetupsApi } from "@client/api/setups";
```

Add to the routes object:

```ts
const setupsApi = makeSetupsApi({ db });
// ...
routes: {
  // ...existing...
  "/api/setups": { GET: setupsApi.list },
  "/api/setups/:id": { GET: setupsApi.get },
  "/api/setups/:id/events": { GET: setupsApi.events },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/client/api/setups.ts src/client/server.ts test/client/api/setups.test.ts
git commit -m "feat(tf-web): setups API (list + detail + events)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Events list (paginated by cursor)

**Files:**
- Create: `src/client/api/events.ts`
- Test: `test/client/api/events.test.ts`

- [ ] **Step 1: Write the test**

Create `test/client/api/events.test.ts`:

```ts
import { startTestPostgres } from "@test-helpers/postgres";
import { events, setups } from "@adapters/persistence/schema";
import { makeEventsApi } from "@client/api/events";
import { describe, expect, test } from "bun:test";

describe("events API", () => {
  test("GET /api/events paginates with ?since cursor", async () => {
    const tp = await startTestPostgres();
    try {
      const setupId = crypto.randomUUID();
      await tp.db.insert(setups).values({
        id: setupId, watchId: "btc-1h", asset: "BTCUSDT", timeframe: "1h",
        status: "REVIEWING", currentScore: "55",
        ttlCandles: 50, ttlExpiresAt: new Date(Date.now() + 1e9),
        workflowId: "wf-1",
      });

      for (let i = 1; i <= 5; i++) {
        await tp.db.insert(events).values({
          setupId, sequence: i, stage: "REVIEWER", actor: "x",
          type: "Strengthened", scoreAfter: String(20 + i * 5),
          statusBefore: "REVIEWING", statusAfter: "REVIEWING",
          payload: { type: "Strengthened", data: { reasoning: "x", observations: [], source: "reviewer_full" } } as never,
        });
      }

      const api = makeEventsApi({ db: tp.db });
      const all = await api.list(new Request("http://x/api/events?limit=3"));
      const items = await all.json() as { id: string; occurredAt: string }[];
      expect(items.length).toBe(3);

      const cursor = items[items.length - 1]!.occurredAt;
      const next = await api.list(
        new Request(`http://x/api/events?limit=3&since=${encodeURIComponent(cursor)}`)
      );
      const more = await next.json() as unknown[];
      expect(more.length).toBe(2);
    } finally { await tp.cleanup(); }
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test test/client/api/events.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement**

Create `src/client/api/events.ts`:

```ts
import { events, setups } from "@adapters/persistence/schema";
import { safeHandler } from "@client/api/safeHandler";
import { and, asc, eq, gt } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

export function makeEventsApi(deps: { db: DB }) {
  return {
    list: safeHandler(async (req) => {
      const url = new URL(req.url);
      const since = url.searchParams.get("since");
      const watchId = url.searchParams.get("watchId");
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));

      const filters = [];
      if (since) filters.push(gt(events.occurredAt, new Date(since)));

      const baseQuery = deps.db
        .select({
          id: events.id, setupId: events.setupId, sequence: events.sequence,
          occurredAt: events.occurredAt, type: events.type,
          scoreDelta: events.scoreDelta, scoreAfter: events.scoreAfter,
          statusBefore: events.statusBefore, statusAfter: events.statusAfter,
          payload: events.payload, provider: events.provider, model: events.model,
          costUsd: events.costUsd, latencyMs: events.latencyMs,
          watchId: setups.watchId,
        })
        .from(events)
        .innerJoin(setups, eq(events.setupId, setups.id));

      const rows = await (watchId
        ? baseQuery.where(and(eq(setups.watchId, watchId), ...filters))
        : filters.length ? baseQuery.where(and(...filters)) : baseQuery
      )
        .orderBy(asc(events.occurredAt), asc(events.id))
        .limit(limit);

      return Response.json(rows);
    }),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test test/client/api/events.test.ts`
Expected: 1 test passes.

- [ ] **Step 5: Wire into server, commit**

Add to `src/client/server.ts` imports and routes:

```ts
import { makeEventsApi } from "@client/api/events";
// ...
const eventsApi = makeEventsApi({ db });
// ...routes:
"/api/events": { GET: eventsApi.list },
```

```bash
git add src/client/api/events.ts src/client/server.ts test/client/api/events.test.ts
git commit -m "feat(tf-web): events API with cursor pagination

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Ticks list + chart artifact streaming

**Files:**
- Create: `src/client/api/ticks.ts`, `src/client/lib/artifacts.ts`
- Test: `test/client/lib/artifacts.test.ts`

- [ ] **Step 1: Write the artifact streaming test**

Create `test/client/lib/artifacts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { streamArtifact } from "@client/lib/artifacts";

describe("streamArtifact", () => {
  test("returns 200 with content-type for known PNG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-art-"));
    const path = join(dir, "chart.png");
    writeFileSync(path, Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await streamArtifact({ uri: `file://${path}`, baseDir: dir });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  test("returns 404 if file missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-art-"));
    const res = await streamArtifact({ uri: `file://${dir}${sep}missing.png`, baseDir: dir });
    expect(res.status).toBe(404);
  });

  test("rejects path traversal outside baseDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-art-"));
    const res = await streamArtifact({ uri: "file:///etc/passwd", baseDir: dir });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Implement `artifacts.ts`**

Create `src/client/lib/artifacts.ts`:

```ts
import { resolve } from "node:path";

const MIMES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  json: "application/json", svg: "image/svg+xml",
};

export async function streamArtifact(input: { uri: string; baseDir: string }): Promise<Response> {
  const { uri, baseDir } = input;
  const path = uri.replace(/^file:\/\//, "");
  const resolved = resolve(path);
  const baseResolved = resolve(baseDir);
  if (!resolved.startsWith(baseResolved)) {
    return new Response("forbidden", { status: 403 });
  }

  const file = Bun.file(resolved);
  if (!(await file.exists())) {
    return new Response("not found", { status: 404 });
  }

  const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIMES[ext] ?? "application/octet-stream";

  return new Response(file.stream(), {
    status: 200,
    headers: { "content-type": mime, "cache-control": "private, max-age=300" },
  });
}
```

- [ ] **Step 3: Run the artifact tests**

Run: `bun test test/client/lib/artifacts.test.ts`
Expected: 3 tests pass.

- [ ] **Step 4: Implement `ticks.ts`**

Create `src/client/api/ticks.ts`:

```ts
import { artifacts as artifactsTbl, tickSnapshots } from "@adapters/persistence/schema";
import { NotFoundError, safeHandler } from "@client/api/safeHandler";
import { streamArtifact } from "@client/lib/artifacts";
import { desc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

const ARTIFACTS_BASE_DIR = process.env.ARTIFACTS_BASE_DIR ?? "/data/artifacts";

export function makeTicksApi(deps: { db: DB }) {
  return {
    list: safeHandler(async (req) => {
      const url = new URL(req.url);
      const watchId = url.searchParams.get("watchId");
      if (!watchId) return Response.json({ error: "watchId required" }, { status: 400 });
      const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));

      const rows = await deps.db
        .select()
        .from(tickSnapshots)
        .where(eq(tickSnapshots.watchId, watchId))
        .orderBy(desc(tickSnapshots.tickAt))
        .limit(limit);
      return Response.json(rows);
    }),

    chartPng: safeHandler(async (_req, params) => {
      const id = params!.id!;
      const [tick] = await deps.db.select().from(tickSnapshots).where(eq(tickSnapshots.id, id));
      if (!tick) throw new NotFoundError(`tick ${id} not found`);
      return streamArtifact({ uri: tick.chartUri, baseDir: ARTIFACTS_BASE_DIR });
    }),
  };
}
```

- [ ] **Step 5: Wire into `server.ts`**

```ts
import { makeTicksApi } from "@client/api/ticks";
// ...
const ticksApi = makeTicksApi({ db });
// routes:
"/api/ticks": { GET: ticksApi.list },
"/api/ticks/:id/chart.png": { GET: ticksApi.chartPng },
```

- [ ] **Step 6: Commit**

```bash
git add src/client/api/ticks.ts src/client/lib/artifacts.ts src/client/server.ts test/client/lib/artifacts.test.ts
git commit -m "feat(tf-web): ticks API + artifact streaming with path-traversal guard

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Setup OHLCV streaming (for `lightweight-charts`)

**Files:**
- Modify: `src/client/api/setups.ts`, `src/client/server.ts`

- [ ] **Step 1: Add the test case to `setups.test.ts`**

Append to `test/client/api/setups.test.ts`:

```ts
test("GET /api/setups/:id/ohlcv returns OHLCV from latest tickSnapshot", async () => {
  const tp = await startTestPostgres();
  try {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "tf-ohlcv-"));
    process.env.ARTIFACTS_BASE_DIR = dir;
    const ohlcvPath = join(dir, "ohlcv.json");
    writeFileSync(ohlcvPath, JSON.stringify([{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }]));

    const setupId = crypto.randomUUID();
    await tp.db.insert(setups).values({
      id: setupId, watchId: "btc-1h", asset: "BTCUSDT", timeframe: "1h",
      status: "REVIEWING", currentScore: "55",
      ttlCandles: 50, ttlExpiresAt: new Date(Date.now() + 1e9),
      workflowId: "wf",
    });

    const { tickSnapshots } = await import("@adapters/persistence/schema");
    await tp.db.insert(tickSnapshots).values({
      watchId: "btc-1h", tickAt: new Date(), asset: "BTCUSDT", timeframe: "1h",
      ohlcvUri: `file://${ohlcvPath}`, chartUri: `file://${ohlcvPath}`,
      indicators: {} as never, preFilterPass: true,
    });

    const api = makeSetupsApi({ db: tp.db });
    const res = await api.ohlcv(new Request("http://x"), { id: setupId });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
  } finally { await tp.cleanup(); }
});
```

- [ ] **Step 2: Add `ohlcv` handler to `setups.ts`**

Replace the returned object in `src/client/api/setups.ts` to add `ohlcv`:

```ts
import { setups, events, tickSnapshots } from "@adapters/persistence/schema";
import { streamArtifact } from "@client/lib/artifacts";
// keep existing imports

export function makeSetupsApi({ db }: SetupsApiDeps) {
  return {
    list: safeHandler(async (req) => { /* unchanged */ }),
    get: safeHandler(async (_req, params) => { /* unchanged */ }),
    events: safeHandler(async (_req, params) => { /* unchanged */ }),

    ohlcv: safeHandler(async (_req, params) => {
      const id = params!.id!;
      const [setup] = await db.select().from(setups).where(eq(setups.id, id));
      if (!setup) throw new NotFoundError(`setup ${id} not found`);

      const [tick] = await db
        .select()
        .from(tickSnapshots)
        .where(eq(tickSnapshots.watchId, setup.watchId))
        .orderBy(desc(tickSnapshots.tickAt))
        .limit(1);
      if (!tick) throw new NotFoundError(`no tickSnapshot for watch ${setup.watchId}`);

      const baseDir = process.env.ARTIFACTS_BASE_DIR ?? "/data/artifacts";
      return streamArtifact({ uri: tick.ohlcvUri, baseDir });
    }),
  };
}
```

- [ ] **Step 3: Wire route**

In `server.ts` routes:

```ts
"/api/setups/:id/ohlcv": { GET: setupsApi.ohlcv },
```

- [ ] **Step 4: Run all setup tests**

Run: `bun test test/client/api/setups.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/api/setups.ts src/client/server.ts test/client/api/setups.test.ts
git commit -m "feat(tf-web): expose OHLCV JSON for setup detail (latest tickSnapshot)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Costs aggregation API

**Files:**
- Create: `src/client/api/costs.ts`
- Test: `test/client/api/costs.test.ts`

- [ ] **Step 1: Write the test**

Create `test/client/api/costs.test.ts`:

```ts
import { startTestPostgres } from "@test-helpers/postgres";
import { events, setups } from "@adapters/persistence/schema";
import { makeCostsApi } from "@client/api/costs";
import { describe, expect, test } from "bun:test";

describe("costs API", () => {
  test("aggregates totals by watch", async () => {
    const tp = await startTestPostgres();
    try {
      const sBtc = crypto.randomUUID();
      const sEth = crypto.randomUUID();
      await tp.db.insert(setups).values([
        { id: sBtc, watchId: "btc-1h", asset: "BTCUSDT", timeframe: "1h", status: "REVIEWING", currentScore: "0", ttlCandles: 50, ttlExpiresAt: new Date(Date.now() + 1e9), workflowId: "w1" },
        { id: sEth, watchId: "eth-4h", asset: "ETHUSDT", timeframe: "4h", status: "REVIEWING", currentScore: "0", ttlCandles: 50, ttlExpiresAt: new Date(Date.now() + 1e9), workflowId: "w2" },
      ]);
      await tp.db.insert(events).values([
        { setupId: sBtc, sequence: 1, stage: "DETECTOR", actor: "x", type: "SetupCreated", scoreAfter: "25", statusBefore: "PROPOSED", statusAfter: "REVIEWING", payload: {} as never, provider: "claude_max", model: "sonnet", costUsd: "0.05" },
        { setupId: sBtc, sequence: 2, stage: "REVIEWER", actor: "x", type: "Strengthened", scoreAfter: "35", statusBefore: "REVIEWING", statusAfter: "REVIEWING", payload: {} as never, provider: "claude_max", model: "haiku", costUsd: "0.02" },
        { setupId: sEth, sequence: 1, stage: "DETECTOR", actor: "x", type: "SetupCreated", scoreAfter: "25", statusBefore: "PROPOSED", statusAfter: "REVIEWING", payload: {} as never, provider: "openrouter", model: "haiku", costUsd: "0.04" },
      ]);

      const api = makeCostsApi({ db: tp.db });
      const res = await api.aggregations(new Request("http://x/api/costs?groupBy=watch"));
      const items = await res.json() as { key: string; totalUsd: number }[];
      const btc = items.find((i) => i.key === "btc-1h");
      const eth = items.find((i) => i.key === "eth-4h");
      expect(btc?.totalUsd).toBeCloseTo(0.07, 4);
      expect(eth?.totalUsd).toBeCloseTo(0.04, 4);
    } finally { await tp.cleanup(); }
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test test/client/api/costs.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement**

Create `src/client/api/costs.ts`:

```ts
import { events, setups } from "@adapters/persistence/schema";
import { safeHandler, ValidationError } from "@client/api/safeHandler";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

type DB = ReturnType<typeof drizzle>;

const VALID_GROUPS = ["watch", "provider", "model", "day"] as const;
type GroupBy = (typeof VALID_GROUPS)[number];

export function makeCostsApi(deps: { db: DB }) {
  return {
    aggregations: safeHandler(async (req) => {
      const url = new URL(req.url);
      const groupBy = (url.searchParams.get("groupBy") ?? "watch") as GroupBy;
      if (!VALID_GROUPS.includes(groupBy)) {
        throw new ValidationError(`groupBy must be one of: ${VALID_GROUPS.join(", ")}`);
      }
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");

      const filters = [];
      if (from) filters.push(gte(events.occurredAt, new Date(from)));
      if (to) filters.push(lte(events.occurredAt, new Date(to)));

      const keyExpr = (() => {
        switch (groupBy) {
          case "watch": return setups.watchId;
          case "provider": return events.provider;
          case "model": return events.model;
          case "day": return sql<string>`to_char(${events.occurredAt}, 'YYYY-MM-DD')`;
        }
      })();

      const rows = await deps.db
        .select({
          key: keyExpr,
          totalUsd: sql<string>`coalesce(sum(${events.costUsd}), 0)`,
          count: sql<string>`count(*)`,
        })
        .from(events)
        .innerJoin(setups, eq(events.setupId, setups.id))
        .where(filters.length ? and(...filters) : undefined)
        .groupBy(keyExpr);

      return Response.json(
        rows.map((r) => ({
          key: r.key,
          totalUsd: Number(r.totalUsd),
          count: Number(r.count),
        }))
      );
    }),
  };
}
```

- [ ] **Step 4: Wire + run + commit**

In `server.ts`:

```ts
import { makeCostsApi } from "@client/api/costs";
// ...
const costsApi = makeCostsApi({ db });
// routes:
"/api/costs": { GET: costsApi.aggregations },
```

Run: `bun test test/client/api/costs.test.ts`
Expected: 1 test passes.

```bash
git add src/client/api/costs.ts src/client/server.ts test/client/api/costs.test.ts
git commit -m "feat(tf-web): costs API with groupBy=watch|provider|model|day

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Admin actions (Temporal signals)

### Task 20: Admin API (force-tick, pause, resume, kill setup)

**Files:**
- Create: `src/client/api/admin.ts`
- Test: `test/client/api/admin.test.ts`

- [ ] **Step 1: Write the test**

Create `test/client/api/admin.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { makeAdminApi } from "@client/api/admin";

describe("admin API", () => {
  test("force-tick calls forceTick helper", async () => {
    const calls: string[] = [];
    const api = makeAdminApi({
      ops: {
        forceTick: async ({ watchId }) => { calls.push(`tick:${watchId}`); },
        pauseWatch: async () => undefined,
        resumeWatch: async () => undefined,
        killSetup: async () => undefined,
      },
    });
    const res = await api.forceTick(new Request("http://x", { method: "POST" }), { id: "btc-1h" });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["tick:btc-1h"]);
  });

  test("pause / resume call the helpers", async () => {
    const calls: string[] = [];
    const api = makeAdminApi({
      ops: {
        forceTick: async () => undefined,
        pauseWatch: async ({ watchId }) => { calls.push(`pause:${watchId}`); },
        resumeWatch: async ({ watchId }) => { calls.push(`resume:${watchId}`); },
        killSetup: async () => undefined,
      },
    });
    await api.pause(new Request("http://x", { method: "POST" }), { id: "btc-1h" });
    await api.resume(new Request("http://x", { method: "POST" }), { id: "btc-1h" });
    expect(calls).toEqual(["pause:btc-1h", "resume:btc-1h"]);
  });

  test("kill setup with default reason", async () => {
    const calls: string[] = [];
    const api = makeAdminApi({
      ops: {
        forceTick: async () => undefined,
        pauseWatch: async () => undefined,
        resumeWatch: async () => undefined,
        killSetup: async ({ setupId, reason }) => { calls.push(`${setupId}:${reason}`); },
      },
    });
    const res = await api.killSetup(
      new Request("http://x", { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } }),
      { id: "abc-123" }
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual(["abc-123:manual_close"]);
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test test/client/api/admin.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `admin.ts`**

Create `src/client/api/admin.ts`:

```ts
import { safeHandler } from "@client/api/safeHandler";

export type AdminOps = {
  forceTick: (input: { watchId: string }) => Promise<void>;
  pauseWatch: (input: { watchId: string }) => Promise<void>;
  resumeWatch: (input: { watchId: string }) => Promise<void>;
  killSetup: (input: { setupId: string; reason: string }) => Promise<void>;
};

export function makeAdminApi(deps: { ops: AdminOps }) {
  return {
    forceTick: safeHandler(async (_req, params) => {
      await deps.ops.forceTick({ watchId: params!.id! });
      return Response.json({ status: "ok", appliedAt: new Date().toISOString() });
    }),
    pause: safeHandler(async (_req, params) => {
      await deps.ops.pauseWatch({ watchId: params!.id! });
      return Response.json({ status: "ok", appliedAt: new Date().toISOString() });
    }),
    resume: safeHandler(async (_req, params) => {
      await deps.ops.resumeWatch({ watchId: params!.id! });
      return Response.json({ status: "ok", appliedAt: new Date().toISOString() });
    }),
    killSetup: safeHandler(async (req, params) => {
      const body = await req.json().catch(() => ({})) as { reason?: string };
      const reason = body.reason ?? "manual_close";
      await deps.ops.killSetup({ setupId: params!.id!, reason });
      return Response.json({ status: "ok", appliedAt: new Date().toISOString() });
    }),
  };
}
```

- [ ] **Step 4: Wire into `server.ts`**

```ts
import { makeAdminApi } from "@client/api/admin";
import { forceTick, killSetup, pauseWatch, resumeWatch } from "@config/watchOps";
// ...
const adminApi = makeAdminApi({
  ops: {
    forceTick: async ({ watchId }) => {
      const client = await getTemporalClient();
      await forceTick({ client, watchId });
    },
    pauseWatch: async ({ watchId }) => {
      const client = await getTemporalClient();
      await pauseWatch({ client, watchId });
    },
    resumeWatch: async ({ watchId }) => {
      const client = await getTemporalClient();
      await resumeWatch({ client, watchId });
    },
    killSetup: async ({ setupId, reason }) => {
      const client = await getTemporalClient();
      await killSetup({ client, setupId, reason });
    },
  },
});
// routes:
"/api/watches/:id/force-tick": { POST: adminApi.forceTick },
"/api/watches/:id/pause": { POST: adminApi.pause },
"/api/watches/:id/resume": { POST: adminApi.resume },
"/api/setups/:id/kill": { POST: adminApi.killSetup },
```

- [ ] **Step 5: Run + commit**

Run: `bun test test/client/api/admin.test.ts`
Expected: 3 tests pass.

```bash
git add src/client/api/admin.ts src/client/server.ts test/client/api/admin.test.ts
git commit -m "feat(tf-web): admin API (force-tick / pause / resume / kill)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Real-time (Broadcaster + Poller + SSE)

### Task 21: Broadcaster (pub/sub fan-out)

**Files:**
- Create: `src/client/lib/broadcaster.ts`
- Test: `test/client/lib/broadcaster.test.ts`

- [ ] **Step 1: Write the test**

Create `test/client/lib/broadcaster.test.ts`:

```ts
import { Broadcaster, type Topic } from "@client/lib/broadcaster";
import { describe, expect, test } from "bun:test";

const fakeSub = () => {
  const received: { topic: Topic; payload: unknown }[] = [];
  return { send: (topic: Topic, payload: unknown) => received.push({ topic, payload }), received };
};

describe("Broadcaster", () => {
  test("emit fans out only to subscribed topics", () => {
    const b = new Broadcaster();
    const a = fakeSub();
    const z = fakeSub();
    b.subscribe(["events"], a);
    b.subscribe(["watches"], z);

    b.emit("events", { id: 1 });
    b.emit("watches", { id: 2 });
    b.emit("ticks", { id: 3 });

    expect(a.received).toEqual([{ topic: "events", payload: { id: 1 } }]);
    expect(z.received).toEqual([{ topic: "watches", payload: { id: 2 } }]);
  });

  test("unsubscribe removes the subscriber", () => {
    const b = new Broadcaster();
    const sub = fakeSub();
    const unsub = b.subscribe(["events"], sub);

    b.emit("events", { id: 1 });
    unsub();
    b.emit("events", { id: 2 });

    expect(sub.received).toEqual([{ topic: "events", payload: { id: 1 } }]);
  });
});
```

- [ ] **Step 2: Implement `broadcaster.ts`**

Create `src/client/lib/broadcaster.ts`:

```ts
export type Topic = "events" | "setups" | "watches" | "ticks";

export type Subscriber = {
  send: (topic: Topic, payload: unknown) => void;
};

export class Broadcaster {
  private subscribers = new Map<Topic, Set<Subscriber>>();

  subscribe(topics: Topic[], sub: Subscriber): () => void {
    for (const t of topics) {
      if (!this.subscribers.has(t)) this.subscribers.set(t, new Set());
      this.subscribers.get(t)!.add(sub);
    }
    return () => topics.forEach((t) => this.subscribers.get(t)?.delete(sub));
  }

  emit(topic: Topic, payload: unknown): void {
    const subs = this.subscribers.get(topic);
    if (!subs) return;
    for (const s of subs) s.send(topic, payload);
  }

  size(topic: Topic): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }
}

export const broadcaster = new Broadcaster();
```

- [ ] **Step 3: Run + commit**

Run: `bun test test/client/lib/broadcaster.test.ts`
Expected: 2 tests pass.

```bash
git add src/client/lib/broadcaster.ts test/client/lib/broadcaster.test.ts
git commit -m "feat(tf-web): in-process broadcaster for SSE fan-out

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 22: Poller (DB cursor advance + emit)

**Files:**
- Create: `src/client/lib/poller.ts`
- Test: `test/client/lib/poller.test.ts`

- [ ] **Step 1: Write the test**

Create `test/client/lib/poller.test.ts`:

```ts
import { startTestPostgres } from "@test-helpers/postgres";
import { Broadcaster } from "@client/lib/broadcaster";
import { startPoller } from "@client/lib/poller";
import { events, setups, tickSnapshots, watchStates } from "@adapters/persistence/schema";
import { describe, expect, test } from "bun:test";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("poller", () => {
  test("emits new events to the broadcaster", async () => {
    const tp = await startTestPostgres();
    try {
      const b = new Broadcaster();
      const seen: unknown[] = [];
      b.subscribe(["events"], { send: (_, p) => seen.push(p) });

      const setupId = crypto.randomUUID();
      await tp.db.insert(setups).values({
        id: setupId, watchId: "btc-1h", asset: "BTCUSDT", timeframe: "1h",
        status: "REVIEWING", currentScore: "0",
        ttlCandles: 50, ttlExpiresAt: new Date(Date.now() + 1e9), workflowId: "w",
      });

      const stop = startPoller({ pool: tp.pool, broadcaster: b, intervalMs: 200, batchSize: 100 });
      await wait(100);

      await tp.db.insert(events).values({
        setupId, sequence: 1, stage: "DETECTOR", actor: "x",
        type: "SetupCreated", scoreAfter: "25",
        statusBefore: "PROPOSED", statusAfter: "REVIEWING",
        payload: {} as never,
      });

      await wait(500);
      stop();
      expect(seen.length).toBeGreaterThanOrEqual(1);
    } finally { await tp.cleanup(); }
  });

  test("does not duplicate events across polls", async () => {
    const tp = await startTestPostgres();
    try {
      const b = new Broadcaster();
      const seen: { id: string }[] = [];
      b.subscribe(["events"], { send: (_, p) => seen.push(p as { id: string }) });

      const setupId = crypto.randomUUID();
      await tp.db.insert(setups).values({
        id: setupId, watchId: "btc-1h", asset: "BTCUSDT", timeframe: "1h",
        status: "REVIEWING", currentScore: "0",
        ttlCandles: 50, ttlExpiresAt: new Date(Date.now() + 1e9), workflowId: "w",
      });
      await tp.db.insert(events).values({
        setupId, sequence: 1, stage: "DETECTOR", actor: "x",
        type: "SetupCreated", scoreAfter: "25",
        statusBefore: "PROPOSED", statusAfter: "REVIEWING",
        payload: {} as never,
      });

      const stop = startPoller({ pool: tp.pool, broadcaster: b, intervalMs: 100, batchSize: 100 });
      await wait(450);
      stop();

      const ids = new Set(seen.map((e) => e.id));
      expect(ids.size).toBe(seen.length);  // no duplicates
    } finally { await tp.cleanup(); }
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test test/client/lib/poller.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement the poller**

Create `src/client/lib/poller.ts`:

```ts
import { events, setups, tickSnapshots, watchStates } from "@adapters/persistence/schema";
import type { Broadcaster } from "@client/lib/broadcaster";
import { childLogger } from "@client/lib/logger";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

const log = childLogger({ module: "poller" });

export type PollerOpts = {
  pool: pg.Pool;
  broadcaster: Broadcaster;
  intervalMs?: number;
  batchSize?: number;
};

export function startPoller(opts: PollerOpts): () => void {
  const { pool, broadcaster } = opts;
  const interval = opts.intervalMs ?? 1500;
  const batch = opts.batchSize ?? 200;
  const db = drizzle(pool);

  const cursors = {
    events: new Date(Date.now() - 5_000),
    setups: new Date(Date.now() - 5_000),
    ticks: new Date(Date.now() - 5_000),
    watchStates: new Date(Date.now() - 5_000),
  };

  let stopped = false;

  async function poll() {
    if (stopped) return;
    try {
      const eventsRows = await db
        .select({
          id: events.id, setupId: events.setupId, sequence: events.sequence,
          occurredAt: events.occurredAt, type: events.type,
          scoreDelta: events.scoreDelta, scoreAfter: events.scoreAfter,
          statusBefore: events.statusBefore, statusAfter: events.statusAfter,
          payload: events.payload, provider: events.provider, model: events.model,
          costUsd: events.costUsd, latencyMs: events.latencyMs,
          watchId: setups.watchId,
        })
        .from(events)
        .innerJoin(setups, eq(events.setupId, setups.id))
        .where(gt(events.occurredAt, cursors.events))
        .orderBy(asc(events.occurredAt), asc(events.id))
        .limit(batch);

      for (const r of eventsRows) {
        broadcaster.emit("events", r);
        if (r.occurredAt > cursors.events) cursors.events = r.occurredAt;
      }

      const setupRows = await db
        .select()
        .from(setups)
        .where(gt(setups.updatedAt, cursors.setups))
        .orderBy(asc(setups.updatedAt))
        .limit(batch);
      for (const r of setupRows) {
        broadcaster.emit("setups", r);
        if (r.updatedAt > cursors.setups) cursors.setups = r.updatedAt;
      }

      const tickRows = await db
        .select()
        .from(tickSnapshots)
        .where(gt(tickSnapshots.createdAt, cursors.ticks))
        .orderBy(asc(tickSnapshots.createdAt))
        .limit(batch);
      for (const r of tickRows) {
        broadcaster.emit("ticks", r);
        if (r.createdAt > cursors.ticks) cursors.ticks = r.createdAt;
      }

      const watchRows = await db
        .select()
        .from(watchStates)
        .where(and(isNotNull(watchStates.lastTickAt), gt(watchStates.lastTickAt, cursors.watchStates)));
      for (const r of watchRows) {
        broadcaster.emit("watches", r);
        if (r.lastTickAt && r.lastTickAt > cursors.watchStates) cursors.watchStates = r.lastTickAt;
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, "poll iteration failed");
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    const start = Date.now();
    await poll();
    const elapsed = Date.now() - start;
    if (elapsed > interval * 3) log.warn({ elapsed }, "poll took longer than 3 intervals");
    if (!stopped) timer = setTimeout(tick, Math.max(0, interval - elapsed));
  };
  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/client/lib/poller.test.ts`
Expected: 2 tests pass (might take a few seconds — they include `wait()` calls).

- [ ] **Step 5: Commit**

```bash
git add src/client/lib/poller.ts test/client/lib/poller.test.ts
git commit -m "feat(tf-web): DB poller emitting events/setups/ticks/watches to broadcaster

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 23: SSE endpoint `/api/stream`

**Files:**
- Create: `src/client/api/stream.ts`
- Modify: `src/client/server.ts`

- [ ] **Step 1: Write the test**

Create `test/client/api/stream.test.ts`:

```ts
import { Broadcaster } from "@client/lib/broadcaster";
import { makeStreamHandler } from "@client/api/stream";
import { describe, expect, test } from "bun:test";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const decode = (chunk: Uint8Array) => new TextDecoder().decode(chunk);

describe("SSE stream", () => {
  test("subscribes to topics from query string and pushes payloads", async () => {
    const b = new Broadcaster();
    const handler = makeStreamHandler({ broadcaster: b, heartbeatMs: 10_000 });
    const res = await handler(new Request("http://x/api/stream?topics=events"));

    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    setTimeout(() => b.emit("events", { id: "abc", type: "Strengthened" }), 30);

    let buf = "";
    while (!buf.includes("Strengthened")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decode(value!);
    }
    expect(buf).toContain("event: events");
    expect(buf).toContain("Strengthened");
    await reader.cancel();
  });

  test("emits heartbeat lines", async () => {
    const b = new Broadcaster();
    const handler = makeStreamHandler({ broadcaster: b, heartbeatMs: 50 });
    const res = await handler(new Request("http://x/api/stream"));
    const reader = res.body!.getReader();

    let buf = "";
    const start = Date.now();
    while (!buf.includes("heartbeat") && Date.now() - start < 1000) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decode(value!);
    }
    expect(buf).toContain("heartbeat");
    await reader.cancel();
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test test/client/api/stream.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `stream.ts`**

Create `src/client/api/stream.ts`:

```ts
import type { Broadcaster, Topic } from "@client/lib/broadcaster";

const ALL_TOPICS: Topic[] = ["events", "setups", "watches", "ticks"];

export function makeStreamHandler(deps: { broadcaster: Broadcaster; heartbeatMs?: number }) {
  const heartbeat = deps.heartbeatMs ?? 25_000;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const requested = (url.searchParams.get("topics") ?? "events,setups,watches,ticks").split(",") as Topic[];
    const topics = requested.filter((t): t is Topic => ALL_TOPICS.includes(t));

    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const safeEnqueue = (chunk: Uint8Array) => {
          if (closed) return;
          try { controller.enqueue(chunk); } catch { closed = true; }
        };

        const subscriber = {
          send: (topic: Topic, payload: unknown) => {
            const id = (payload as { id?: string }).id ?? Date.now().toString();
            const msg = `id: ${id}\nevent: ${topic}\ndata: ${JSON.stringify(payload)}\n\n`;
            safeEnqueue(encoder.encode(msg));
          },
        };

        const unsub = deps.broadcaster.subscribe(topics, subscriber);

        const hbInterval = setInterval(() => safeEnqueue(encoder.encode(`: heartbeat\n\n`)), heartbeat);

        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(hbInterval);
          unsub();
          try { controller.close(); } catch { /* already closed */ }
        };

        req.signal.addEventListener("abort", close);
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/client/api/stream.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Wire stream + start poller in `server.ts`**

Add at top of `src/client/server.ts`:

```ts
import { makeStreamHandler } from "@client/api/stream";
import { broadcaster } from "@client/lib/broadcaster";
import { startPoller } from "@client/lib/poller";
import { pool } from "@client/lib/db";
```

After the route definitions but before `webLogger.info(...)`:

```ts
const stopPoller = startPoller({
  pool,
  broadcaster,
  intervalMs: Number(process.env.TF_WEB_POLL_INTERVAL_MS ?? 1500),
  batchSize: Number(process.env.TF_WEB_POLL_BATCH_SIZE ?? 200),
});
process.on("SIGTERM", () => stopPoller());
process.on("SIGINT", () => stopPoller());
```

Add to routes:

```ts
"/api/stream": { GET: makeStreamHandler({ broadcaster }) },
```

- [ ] **Step 6: Commit**

```bash
git add src/client/api/stream.ts src/client/server.ts test/client/api/stream.test.ts
git commit -m "feat(tf-web): SSE /api/stream endpoint + start poller on boot

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6 — Frontend foundation

### Task 24: Tailwind v4 + bun-plugin-tailwind setup (with v3 fallback decision)

**Files:**
- Modify: `package.json`
- Create: `bunfig.toml`, `src/client/globals.css`

- [ ] **Step 1: Try Tailwind v4 + plugin first**

Run:

```bash
bun add tailwindcss@^4 tailwindcss-animate
bun add -d bun-plugin-tailwind
```

Create `bunfig.toml` at the project root:

```toml
[serve.static]
plugins = ["bun-plugin-tailwind"]
```

Create `src/client/globals.css`:

```css
@import "tailwindcss";
@plugin "tailwindcss-animate";

@layer base {
  :root {
    --background: 0 0% 4%;
    --foreground: 0 0% 95%;
    --card: 0 0% 7%;
    --card-foreground: 0 0% 95%;
    --popover: 0 0% 7%;
    --popover-foreground: 0 0% 95%;
    --primary: 220 70% 60%;
    --primary-foreground: 0 0% 100%;
    --secondary: 0 0% 14%;
    --secondary-foreground: 0 0% 95%;
    --muted: 0 0% 14%;
    --muted-foreground: 0 0% 60%;
    --accent: 0 0% 14%;
    --accent-foreground: 0 0% 95%;
    --destructive: 0 70% 55%;
    --destructive-foreground: 0 0% 100%;
    --border: 0 0% 18%;
    --input: 0 0% 18%;
    --ring: 220 70% 60%;
    --radius: 0.5rem;

    --chart-1: 220 70% 60%;
    --chart-2: 160 60% 50%;
    --chart-3: 30 80% 60%;
    --chart-4: 280 70% 60%;
    --chart-5: 0 70% 60%;
  }
}

body { background-color: hsl(var(--background)); color: hsl(var(--foreground)); }
```

- [ ] **Step 2: Validate Tailwind v4 builds**

Create a probe HTML in `src/client/index.html`:

```html
<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <title>tf-web (probe)</title>
    <link rel="stylesheet" href="./globals.css" />
  </head>
  <body class="bg-neutral-950 text-neutral-100 p-8">
    <h1 class="text-2xl font-bold">tf-web probe</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

Add a temporary minimal `src/client/frontend.tsx`:

```tsx
import { createRoot } from "react-dom/client";
const root = createRoot(document.getElementById("root") ?? document.body);
root.render(<div className="text-emerald-400 mt-4">Tailwind v4 working ✓</div>);
```

Wire it into the server. Replace the `routes` block in `src/client/server.ts`:

```ts
import index from "./index.html";
// ...
routes: {
  "/": index,
  "/health": { GET: health },
  // ...rest unchanged
}
```

Boot: `WEB_PORT=8084 DATABASE_URL=... bun run src/client/server.ts &`
Open: `curl -s http://localhost:8084/` and visually confirm a HTML response with embedded Tailwind classes.

If the output looks correct (Tailwind classes resolved, no PostCSS errors), continue with v4. If `bun-plugin-tailwind` errors out on `@import "tailwindcss"` (v4 syntax), fall back to v3:

- [ ] **Step 3 (only if v4 fails — fallback to v3)**

```bash
bun remove tailwindcss
bun add tailwindcss@^3.4
```

Create `tailwind.config.cjs`:

```js
module.exports = {
  content: ["./src/client/**/*.{ts,tsx,html}"],
  theme: { extend: {} },
  plugins: [require("tailwindcss-animate")],
};
```

Replace `globals.css` content with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* (keep the same @layer base { :root { ... } } block as in Step 1) */
```

Re-test the probe; confirm v3 builds.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock bunfig.toml src/client/globals.css src/client/index.html src/client/frontend.tsx src/client/server.ts tailwind.config.cjs
git commit -m "feat(tf-web): set up Tailwind + bun-plugin-tailwind + global CSS variables

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 25: shadcn/ui init + components

**Files:**
- Create: `components.json`
- Generate: `src/client/components/ui/*` (via shadcn CLI)
- Create: `src/client/lib/utils.ts`

- [ ] **Step 1: Create `components.json` manually (we don't use any of shadcn's official framework templates)**

Create `components.json`:

```jsonc
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/client/globals.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@client/components",
    "ui": "@client/components/ui",
    "utils": "@client/lib/utils",
    "lib": "@client/lib",
    "hooks": "@client/hooks"
  }
}
```

- [ ] **Step 2: Create the `cn` utility**

Create `src/client/lib/utils.ts`:

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

Install peer deps:

```bash
bun add clsx tailwind-merge
```

- [ ] **Step 3: Add shadcn components in one batch**

Run:

```bash
bunx shadcn@latest add \
  button card badge tabs dialog sheet drawer accordion separator skeleton \
  form input select switch slider tooltip sonner table chart label
```

Answer prompts (TypeScript = yes, base color = neutral, etc.). Confirm files appear under `src/client/components/ui/`.

- [ ] **Step 4: Smoke-test by importing one component**

Add to `src/client/frontend.tsx`:

```tsx
import { Button } from "@client/components/ui/button";
import { createRoot } from "react-dom/client";

const root = createRoot(document.getElementById("root") ?? document.body);
root.render(<Button>Hello</Button>);
```

Boot the server, visit `/`. Visually confirm a styled button renders.

- [ ] **Step 5: Commit**

```bash
git add components.json src/client/lib/utils.ts src/client/components/ui/ src/client/frontend.tsx package.json bun.lock
git commit -m "feat(tf-web): shadcn/ui init + import all needed components

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 26: React Query + Router setup + API fetch wrapper

**Files:**
- Create: `src/client/lib/api.ts`, `src/client/lib/queryClient.ts`, `src/client/lib/format.ts`

- [ ] **Step 1: Implement the API fetch wrapper**

Create `src/client/lib/api.ts`:

```ts
export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, body, `${res.status} ${res.statusText}`);
  }
  return body as T;
}
```

- [ ] **Step 2: QueryClient config**

Create `src/client/lib/queryClient.ts`:

```ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
    mutations: { retry: 0 },
  },
});
```

- [ ] **Step 3: Format helpers**

Create `src/client/lib/format.ts`:

```ts
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";

export function fmtRelative(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return formatDistanceToNow(typeof d === "string" ? new Date(d) : d, { addSuffix: true, locale: fr });
}

export function fmtCost(usd: string | number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  const n = typeof usd === "string" ? Number(usd) : usd;
  return `$${n.toFixed(2)}`;
}

export function fmtScore(score: string | number): string {
  const n = typeof score === "string" ? Number(score) : score;
  return n.toFixed(0);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/client/lib/
git commit -m "feat(tf-web): API fetch wrapper + QueryClient + format helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 27: `useSSEStream` hook

**Files:**
- Create: `src/client/hooks/useSSEStream.ts`
- Test: `test/client/frontend/hooks/useSSEStream.test.ts`

- [ ] **Step 1: Set up happy-dom registrator for tests**

Create `test/client/frontend/setup.ts`:

```ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
```

Add a `bunfig.toml` test entry:

```toml
[test]
preload = ["./test/client/frontend/setup.ts"]
```

(If `bunfig.toml` already has `[serve.static]`, add `[test]` as a new section.)

- [ ] **Step 2: Write the hook test**

Create `test/client/frontend/hooks/useSSEStream.test.ts`:

```ts
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSSEStream } from "@client/hooks/useSSEStream";
import { describe, expect, mock, test } from "bun:test";
import * as React from "react";

class FakeES {
  static instance: FakeES | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(public url: string) { FakeES.instance = this; }
  addEventListener(t: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners.has(t)) this.listeners.set(t, []);
    this.listeners.get(t)!.push(fn);
  }
  fire(topic: string, data: unknown) {
    const ev = new MessageEvent("message", { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(topic) ?? []) fn(ev);
  }
  close() {}
}

(globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;

const wrap = (qc: QueryClient) => ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client: qc }, children);

describe("useSSEStream", () => {
  test("invalidates queries on `events` push", async () => {
    const qc = new QueryClient();
    const spy = mock(qc.invalidateQueries.bind(qc));
    qc.invalidateQueries = spy;

    renderHook(() => useSSEStream(), { wrapper: wrap(qc) });

    await act(async () => {
      FakeES.instance?.fire("events", { id: "e1", setupId: "s1" });
    });

    await waitFor(() => {
      expect(spy.mock.calls.some((c) => JSON.stringify(c).includes("setups"))).toBe(true);
    });
  });

  test("appends to ['events','live'] live feed", async () => {
    const qc = new QueryClient();
    renderHook(() => useSSEStream(), { wrapper: wrap(qc) });

    await act(async () => {
      FakeES.instance?.fire("events", { id: "e1", setupId: "s1" });
    });

    const live = qc.getQueryData<unknown[]>(["events", "live"]) ?? [];
    expect(live.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Implement the hook**

Create `src/client/hooks/useSSEStream.ts`:

```ts
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

type EventRow = { id: string; setupId: string; watchId?: string; type: string };
type SetupRow = { id: string; watchId: string };
type TickRow = { watchId: string };

export function useSSEStream() {
  const qc = useQueryClient();

  useEffect(() => {
    const sse = new EventSource("/api/stream?topics=events,setups,watches,ticks");

    sse.addEventListener("events", (e: MessageEvent) => {
      const evt = JSON.parse(e.data) as EventRow;
      qc.setQueryData<EventRow[]>(["events", "live"], (old = []) => [evt, ...old].slice(0, 100));
      qc.invalidateQueries({ queryKey: ["setups", evt.setupId] });
      qc.invalidateQueries({ queryKey: ["setups", evt.setupId, "events"] });
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["costs"] });
    });

    sse.addEventListener("setups", () => {
      qc.invalidateQueries({ queryKey: ["setups"] });
    });

    sse.addEventListener("watches", () => {
      qc.invalidateQueries({ queryKey: ["watches"] });
    });

    sse.addEventListener("ticks", (e: MessageEvent) => {
      const tick = JSON.parse(e.data) as TickRow;
      qc.invalidateQueries({ queryKey: ["ticks", tick.watchId] });
      qc.invalidateQueries({ queryKey: ["watches"] });
    });

    return () => sse.close();
  }, [qc]);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test test/client/frontend/hooks/useSSEStream.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/hooks/useSSEStream.ts test/client/frontend/setup.ts test/client/frontend/hooks/useSSEStream.test.ts bunfig.toml
git commit -m "feat(tf-web): useSSEStream hook driving TanStack invalidation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 28: Router + RootLayout + final `frontend.tsx`

**Files:**
- Create: `src/client/routes/root.tsx`, `src/client/routes/error.tsx`
- Modify: `src/client/frontend.tsx`, `src/client/index.html`

- [ ] **Step 1: ErrorBoundary route**

Create `src/client/routes/error.tsx`:

```tsx
import { useRouteError } from "react-router-dom";

export function ErrorPage() {
  const err = useRouteError() as { message?: string } | undefined;
  return (
    <div className="p-8">
      <h1 className="text-xl font-bold">Erreur</h1>
      <p className="text-muted-foreground mt-2">{err?.message ?? "Quelque chose s'est mal passé."}</p>
    </div>
  );
}
```

- [ ] **Step 2: RootLayout**

Create `src/client/routes/root.tsx`:

```tsx
import { useSSEStream } from "@client/hooks/useSSEStream";
import { Link, NavLink, Outlet } from "react-router-dom";

export function RootLayout() {
  useSSEStream();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="flex items-center gap-6 px-6 h-12">
          <Link to="/" className="font-bold tracking-wide">trading-flow</Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <NavLink to="/" end className={({ isActive }) => isActive ? "text-foreground" : ""}>Dashboard</NavLink>
            <NavLink to="/live-events" className={({ isActive }) => isActive ? "text-foreground" : ""}>Live events</NavLink>
            <NavLink to="/costs" className={({ isActive }) => isActive ? "text-foreground" : ""}>Coûts</NavLink>
          </nav>
        </div>
      </header>
      <div className="grid grid-cols-[1fr_288px] gap-0">
        <main className="p-6"><Outlet /></main>
        <aside className="border-l border-border bg-card/50 p-4 sticky top-12 h-[calc(100vh-3rem)] overflow-auto">
          <LiveEventsSidebar />
        </aside>
      </div>
    </div>
  );
}

// placeholder — real component built in Task 36
function LiveEventsSidebar() {
  return <div className="text-xs text-muted-foreground">Live events…</div>;
}
```

- [ ] **Step 3: Replace `frontend.tsx`**

Replace `src/client/frontend.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@client/components/ui/sonner";
import { queryClient } from "@client/lib/queryClient";
import { ErrorPage } from "@client/routes/error";
import { RootLayout } from "@client/routes/root";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import "./globals.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, lazy: () => import("@client/routes/dashboard") },
      { path: "watches/new", lazy: () => import("@client/routes/watch-new") },
      { path: "watches/:id", lazy: () => import("@client/routes/watch") },
      { path: "setups/:id", lazy: () => import("@client/routes/setup") },
      { path: "live-events", lazy: () => import("@client/routes/live-events") },
      { path: "costs", lazy: () => import("@client/routes/costs") },
    ],
  },
]);

const container = document.getElementById("root") ?? document.body;
createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster richColors />
    </QueryClientProvider>
  </React.StrictMode>
);
```

- [ ] **Step 4: Update `index.html`**

Replace `src/client/index.html`:

```html
<!DOCTYPE html>
<html lang="fr" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>trading-flow</title>
  </head>
  <body class="bg-background text-foreground">
    <div id="root"></div>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Stub the lazy routes (each must export `Component`)**

Create the 6 placeholder route files so the lazy imports resolve:

`src/client/routes/dashboard.tsx`:

```tsx
export function Component() { return <div>Dashboard</div>; }
```

`src/client/routes/watch-new.tsx`, `watch.tsx`, `setup.tsx`, `live-events.tsx`, `costs.tsx` — each:

```tsx
export function Component() { return <div>Coming soon</div>; }
```

(They get fleshed out in Phase 7–10.)

- [ ] **Step 6: Smoke-test the bundle**

Boot the server, visit `/`. Confirm React renders, the header is visible with nav links, and clicking each link routes without errors (the placeholders show).

- [ ] **Step 7: Commit**

```bash
git add src/client/routes/ src/client/frontend.tsx src/client/index.html
git commit -m "feat(tf-web): React Router + RootLayout + lazy route placeholders

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7 — Dashboard

### Task 29: WatchCard component + Dashboard route

**Files:**
- Create: `src/client/components/watch-card.tsx`, `src/client/components/shared/relative-time.tsx`, `src/client/components/shared/confirm-action.tsx`, `src/client/hooks/useWatches.ts`, `src/client/hooks/useAdminAction.ts`
- Modify: `src/client/routes/dashboard.tsx`

- [ ] **Step 1: `useWatches` query hook**

Create `src/client/hooks/useWatches.ts`:

```ts
import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";

export type WatchListItem = {
  id: string;
  enabled: boolean;
  version: number;
  config: { id: string; asset: { symbol: string }; timeframes: { primary: string } };
  createdAt: string;
  updatedAt: string;
};

export function useWatches() {
  return useQuery({
    queryKey: ["watches"],
    queryFn: () => api<WatchListItem[]>("/api/watches"),
    staleTime: 30_000,
  });
}
```

- [ ] **Step 2: `useAdminAction` mutation hook**

Create `src/client/hooks/useAdminAction.ts`:

```ts
import { api } from "@client/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export function useAdminAction() {
  const qc = useQueryClient();

  const forceTick = useMutation({
    mutationFn: (watchId: string) =>
      api(`/api/watches/${watchId}/force-tick`, { method: "POST" }),
    onSuccess: (_d, watchId) => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      toast.success(`Tick forcé pour ${watchId}`);
    },
    onError: (err) => toast.error(`Échec : ${(err as Error).message}`),
  });

  const pause = useMutation({
    mutationFn: (watchId: string) =>
      api(`/api/watches/${watchId}/pause`, { method: "POST" }),
    onSuccess: (_d, watchId) => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      toast.success(`${watchId} mis en pause`);
    },
  });

  const resume = useMutation({
    mutationFn: (watchId: string) =>
      api(`/api/watches/${watchId}/resume`, { method: "POST" }),
    onSuccess: (_d, watchId) => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      toast.success(`${watchId} relancée`);
    },
  });

  const killSetup = useMutation({
    mutationFn: ({ setupId, reason }: { setupId: string; reason?: string }) =>
      api(`/api/setups/${setupId}/kill`, {
        method: "POST",
        body: JSON.stringify({ reason: reason ?? "manual_close" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["setups"] });
      toast.success("Setup tué");
    },
  });

  return { forceTick, pause, resume, killSetup };
}
```

- [ ] **Step 3: `RelativeTime`**

Create `src/client/components/shared/relative-time.tsx`:

```tsx
import { fmtRelative } from "@client/lib/format";
import { useEffect, useState } from "react";

export function RelativeTime({ date }: { date: string | Date | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return <span>{fmtRelative(date)}</span>;
}
```

- [ ] **Step 4: `ConfirmAction` modal**

Create `src/client/components/shared/confirm-action.tsx`:

```tsx
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@client/components/ui/dialog";
// Note: shadcn ships AlertDialog under "alert-dialog" — if your install put it there, swap import.
import * as React from "react";

export function ConfirmAction(props: {
  title: string;
  description: string;
  trigger: React.ReactNode;
  onConfirm: () => void;
  destructive?: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{props.trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Annuler</AlertDialogCancel>
          <AlertDialogAction
            onClick={props.onConfirm}
            className={props.destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
          >
            Confirmer
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

If `bunx shadcn add alert-dialog` was not run in Task 25, run it now: `bunx shadcn@latest add alert-dialog`. Then update the import path:

```tsx
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@client/components/ui/alert-dialog";
```

- [ ] **Step 5: `WatchCard`**

Create `src/client/components/watch-card.tsx`:

```tsx
import { Badge } from "@client/components/ui/badge";
import { Button } from "@client/components/ui/button";
import { Card, CardContent, CardHeader } from "@client/components/ui/card";
import { ConfirmAction } from "@client/components/shared/confirm-action";
import { RelativeTime } from "@client/components/shared/relative-time";
import { useAdminAction } from "@client/hooks/useAdminAction";
import type { WatchListItem } from "@client/hooks/useWatches";
import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

type WatchDetail = {
  state: { lastTickAt: string | null; totalCostUsdMtd: string; setupsCreatedMtd: number } | null;
};

export function WatchCard({ watch }: { watch: WatchListItem }) {
  const { forceTick, pause, resume } = useAdminAction();
  const detail = useQuery({
    queryKey: ["watches", watch.id],
    queryFn: () => api<WatchDetail>(`/api/watches/${watch.id}`),
    staleTime: 30_000,
  });

  const aliveSetups = useQuery({
    queryKey: ["setups", { watchId: watch.id, status: "alive" }],
    queryFn: () => api<unknown[]>(`/api/setups?watchId=${watch.id}`),
    staleTime: 5_000,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div>
          <Link to={`/watches/${watch.id}`} className="font-bold font-mono">
            {watch.config.asset.symbol} · {watch.config.timeframes.primary}
          </Link>
          <div className="text-xs text-muted-foreground mt-1">{watch.id}</div>
        </div>
        <Badge variant={watch.enabled ? "default" : "secondary"}>
          {watch.enabled ? "Active" : "Pause"}
        </Badge>
      </CardHeader>
      <CardContent className="text-xs space-y-1">
        <div>
          Dernier tick : <RelativeTime date={detail.data?.state?.lastTickAt} />
        </div>
        <div>
          Setups vivants : <span className="font-mono">{aliveSetups.data?.length ?? "—"}</span>
        </div>
        <div>
          Coût mois : <span className="font-mono">${Number(detail.data?.state?.totalCostUsdMtd ?? 0).toFixed(2)}</span>
        </div>
        <div className="flex gap-2 pt-2">
          {watch.enabled ? (
            <>
              <Button size="sm" variant="outline" onClick={() => forceTick.mutate(watch.id)}>
                Force tick
              </Button>
              <ConfirmAction
                title={`Mettre en pause ${watch.id} ?`}
                description="Les ticks programmés sont suspendus. Reprends quand tu veux."
                trigger={<Button size="sm" variant="outline">Pause</Button>}
                onConfirm={() => pause.mutate(watch.id)}
              />
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => resume.mutate(watch.id)}>
              Reprendre
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6: Replace Dashboard route**

Replace `src/client/routes/dashboard.tsx`:

```tsx
import { Button } from "@client/components/ui/button";
import { WatchCard } from "@client/components/watch-card";
import { useWatches } from "@client/hooks/useWatches";
import { Link } from "react-router-dom";

export function Component() {
  const { data, isLoading, error } = useWatches();
  if (isLoading) return <div className="text-muted-foreground">Chargement…</div>;
  if (error) return <div className="text-destructive">Erreur : {(error as Error).message}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Watches</h1>
        <Button asChild><Link to="/watches/new">+ Nouvelle watch</Link></Button>
      </div>
      {data && data.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.map((w) => <WatchCard key={w.id} watch={w} />)}
        </div>
      ) : (
        <div className="border border-dashed border-border rounded-lg p-12 text-center">
          <p className="text-muted-foreground mb-4">Aucune watch configurée pour l'instant.</p>
          <Button asChild><Link to="/watches/new">Créer la première watch</Link></Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add src/client/components/ src/client/hooks/ src/client/routes/dashboard.tsx
git commit -m "feat(tf-web): Dashboard with WatchCard + admin actions + empty state

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 8 — Watch CRUD pages

### Task 30: WatchForm — sections (Asset / Schedule / Lifecycle)

**Files:**
- Create: `src/client/components/watch-form/index.tsx`, `section-asset.tsx`, `section-schedule.tsx`, `section-lifecycle.tsx`
- Test: `test/client/frontend/components/watch-form.test.ts`

- [ ] **Step 1: Test the form Zod resolver wiring**

Create `test/client/frontend/components/watch-form.test.ts`:

```ts
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WatchForm } from "@client/components/watch-form";
import { describe, expect, mock, test } from "bun:test";
import * as React from "react";

const wrap = ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client: new QueryClient() }, children);

describe("WatchForm", () => {
  test("submitting an empty id surfaces a validation error", async () => {
    const onSubmit = mock(async () => undefined);
    render(<WatchForm onSubmit={onSubmit} mode="create" />, { wrapper: wrap });

    await userEvent.click(screen.getByRole("button", { name: /enregistrer/i }));

    await waitFor(() => {
      expect(screen.getByText(/identifiant/i)).toBeTruthy();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
```

Install testing peer:

```bash
bun add -d @testing-library/user-event
```

- [ ] **Step 2: Implement section components**

Create `src/client/components/watch-form/section-asset.tsx`:

```tsx
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@client/components/ui/select";
import { useFormContext } from "react-hook-form";

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"] as const;
const SOURCES = ["binance", "yahoo"] as const;

export function SectionAsset() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Actif et timeframe</h3>

      <FormField control={f.control} name="id" render={({ field }) => (
        <FormItem>
          <FormLabel>Identifiant</FormLabel>
          <FormControl><Input placeholder="btc-1h" {...field} /></FormControl>
          <FormDescription>Slug unique en minuscules. Sert à retrouver la watch et nommer ses notifications.</FormDescription>
          <FormMessage />
        </FormItem>
      )} />

      <FormField control={f.control} name="asset.symbol" render={({ field }) => (
        <FormItem>
          <FormLabel>Symbole</FormLabel>
          <FormControl><Input placeholder="BTCUSDT" {...field} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />

      <FormField control={f.control} name="asset.source" render={({ field }) => (
        <FormItem>
          <FormLabel>Source de marché</FormLabel>
          <Select value={field.value} onValueChange={field.onChange}>
            <FormControl><SelectTrigger><SelectValue placeholder="Choisir…" /></SelectTrigger></FormControl>
            <SelectContent>{SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
          </Select>
          <FormDescription>Binance pour le crypto, Yahoo pour les actions / indices.</FormDescription>
          <FormMessage />
        </FormItem>
      )} />

      <FormField control={f.control} name="timeframes.primary" render={({ field }) => (
        <FormItem>
          <FormLabel>Timeframe principal</FormLabel>
          <Select value={field.value} onValueChange={field.onChange}>
            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
            <SelectContent>{TIMEFRAMES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )} />
    </section>
  );
}
```

Create `src/client/components/watch-form/section-schedule.tsx`:

```tsx
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { useFormContext } from "react-hook-form";

export function SectionSchedule() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Quand analyser</h3>
      <FormField control={f.control} name="schedule.detector_cron" render={({ field }) => (
        <FormItem>
          <FormLabel>Fréquence d'analyse (cron) — optionnel</FormLabel>
          <FormControl><Input placeholder="*/15 * * * *" {...field} value={field.value ?? ""} /></FormControl>
          <FormDescription>Si vide, dérivé automatiquement du timeframe (ex: 1h → "0 * * * *").</FormDescription>
          <FormMessage />
        </FormItem>
      )} />
      <FormField control={f.control} name="schedule.timezone" render={({ field }) => (
        <FormItem>
          <FormLabel>Fuseau horaire</FormLabel>
          <FormControl><Input placeholder="UTC" {...field} value={field.value ?? "UTC"} /></FormControl>
          <FormMessage />
        </FormItem>
      )} />
    </section>
  );
}
```

Create `src/client/components/watch-form/section-lifecycle.tsx`:

```tsx
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@client/components/ui/select";
import { Slider } from "@client/components/ui/slider";
import { useFormContext } from "react-hook-form";

export function SectionLifecycle() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Cycle de vie d'un setup</h3>

      <FormField control={f.control} name="setup_lifecycle.ttl_candles" render={({ field }) => (
        <FormItem>
          <FormLabel>Durée de vie max (en bougies)</FormLabel>
          <FormControl><Input type="number" {...field} onChange={(e) => field.onChange(Number(e.target.value))} /></FormControl>
          <FormDescription>Au-delà, le setup expire automatiquement.</FormDescription>
          <FormMessage />
        </FormItem>
      )} />

      <FormField control={f.control} name="setup_lifecycle.score_threshold_finalizer" render={({ field }) => (
        <FormItem>
          <FormLabel>Seuil de confirmation : <span className="font-mono">{field.value}</span></FormLabel>
          <FormControl>
            <Slider min={50} max={100} step={5} value={[field.value ?? 80]} onValueChange={(v) => field.onChange(v[0])} />
          </FormControl>
          <FormDescription>Score à atteindre pour déclencher la décision finale GO/NO_GO.</FormDescription>
          <FormMessage />
        </FormItem>
      )} />

      <FormField control={f.control} name="setup_lifecycle.invalidation_policy" render={({ field }) => (
        <FormItem>
          <FormLabel>Politique d'invalidation</FormLabel>
          <Select value={field.value} onValueChange={field.onChange}>
            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
            <SelectContent>
              <SelectItem value="strict">Strict — toute mèche en dessous</SelectItem>
              <SelectItem value="wick_tolerant">Tolérant aux mèches</SelectItem>
              <SelectItem value="confirmed_close">Sur clôture confirmée</SelectItem>
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )} />
    </section>
  );
}
```

- [ ] **Step 3: WatchForm root**

Create `src/client/components/watch-form/index.tsx`:

```tsx
import { Button } from "@client/components/ui/button";
import { Form } from "@client/components/ui/form";
import { SectionAsset } from "@client/components/watch-form/section-asset";
import { SectionLifecycle } from "@client/components/watch-form/section-lifecycle";
import { SectionSchedule } from "@client/components/watch-form/section-schedule";
import { WatchSchema, type WatchConfig } from "@domain/schemas/Config";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type SubmitHandler } from "react-hook-form";

const SENSIBLE_DEFAULTS: Partial<WatchConfig> = {
  enabled: true,
  schedule: { timezone: "UTC" },
  candles: { detector_lookback: 200, reviewer_lookback: 500, reviewer_chart_window: 150 },
  setup_lifecycle: {
    ttl_candles: 50, score_initial: 25,
    score_threshold_finalizer: 80, score_threshold_dead: 10,
    invalidation_policy: "strict", score_max: 100,
  },
  analyzers: {
    detector: { provider: "claude_max", model: "claude-sonnet-4-6", max_tokens: 2000 },
    reviewer: { provider: "claude_max", model: "claude-haiku-4-5", max_tokens: 2000 },
    finalizer: { provider: "claude_max", model: "claude-opus-4-7", max_tokens: 2000 },
  },
  notifications: {
    telegram_chat_id: "", notify_on: ["confirmed", "tp_hit", "sl_hit"],
    include_chart_image: true, include_reasoning: true,
  },
};

export type WatchFormProps = {
  initial?: WatchConfig;
  mode: "create" | "edit";
  onSubmit: SubmitHandler<WatchConfig>;
};

export function WatchForm({ initial, mode, onSubmit }: WatchFormProps) {
  const form = useForm<WatchConfig>({
    resolver: zodResolver(WatchSchema),
    defaultValues: (initial ?? SENSIBLE_DEFAULTS) as WatchConfig,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8 max-w-2xl">
        <SectionAsset />
        <SectionSchedule />
        <SectionLifecycle />
        {/* Sections analyzers / notifications / budget / advanced — added in Task 31 */}
        <div className="flex gap-2 pt-4">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {mode === "create" ? "Créer la watch" : "Enregistrer"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
```

- [ ] **Step 4: Run the form test**

Run: `bun test test/client/frontend/components/watch-form.test.ts`
Expected: 1 test passes (will need to confirm `screen.getByRole("button", { name: /enregistrer/i })` matches "Créer la watch" — adjust the regex to `/créer|enregistrer/i`).

- [ ] **Step 5: Commit**

```bash
git add src/client/components/watch-form/ test/client/frontend/components/watch-form.test.ts package.json bun.lock
git commit -m "feat(tf-web): WatchForm root + Asset/Schedule/Lifecycle sections

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 31: WatchForm — analyzers / notifications / budget / advanced sections

**Files:**
- Create: `src/client/components/watch-form/section-analyzers.tsx`, `section-notifications.tsx`, `section-budget.tsx`, `section-advanced.tsx`
- Modify: `src/client/components/watch-form/index.tsx`

- [ ] **Step 1: SectionAnalyzers**

Create `src/client/components/watch-form/section-analyzers.tsx`:

```tsx
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { useFormContext } from "react-hook-form";

const ROLES = [
  { key: "detector", label: "Détecteur (analyse principale)" },
  { key: "reviewer", label: "Reviewer (raffinement)" },
  { key: "finalizer", label: "Finalizer (décision finale GO/NO_GO)" },
] as const;

export function SectionAnalyzers() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Modèles d'IA</h3>
      <FormDescription>Choisis quel provider et quel modèle utiliser pour chaque étape de l'analyse.</FormDescription>
      {ROLES.map(({ key, label }) => (
        <div key={key} className="space-y-2 border-l-2 border-border pl-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
          <FormField control={f.control} name={`analyzers.${key}.provider`} render={({ field }) => (
            <FormItem><FormLabel>Provider</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={f.control} name={`analyzers.${key}.model`} render={({ field }) => (
            <FormItem><FormLabel>Modèle</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 2: SectionNotifications**

Create `src/client/components/watch-form/section-notifications.tsx`:

```tsx
import { Checkbox } from "@client/components/ui/checkbox";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { Switch } from "@client/components/ui/switch";
import { useFormContext } from "react-hook-form";

const EVENTS = [
  "confirmed", "rejected", "tp_hit", "sl_hit",
  "invalidated", "invalidated_after_confirmed", "expired",
] as const;

export function SectionNotifications() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Notifications Telegram</h3>

      <FormField control={f.control} name="notifications.telegram_chat_id" render={({ field }) => (
        <FormItem>
          <FormLabel>Chat ID Telegram</FormLabel>
          <FormControl><Input {...field} /></FormControl>
          <FormDescription>L'identifiant numérique du chat où envoyer les notifs.</FormDescription>
          <FormMessage />
        </FormItem>
      )} />

      <FormField control={f.control} name="notifications.notify_on" render={({ field }) => (
        <FormItem>
          <FormLabel>Notifier sur</FormLabel>
          <div className="grid grid-cols-2 gap-2 mt-2">
            {EVENTS.map((evt) => {
              const checked = (field.value as string[] | undefined)?.includes(evt) ?? false;
              return (
                <label key={evt} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => {
                      const cur = (field.value as string[] | undefined) ?? [];
                      field.onChange(v ? [...cur, evt] : cur.filter((e) => e !== evt));
                    }}
                  />
                  <span>{evt}</span>
                </label>
              );
            })}
          </div>
          <FormMessage />
        </FormItem>
      )} />

      <FormField control={f.control} name="notifications.include_chart_image" render={({ field }) => (
        <FormItem className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <FormLabel>Joindre le graphique</FormLabel>
            <FormDescription>Image PNG annotée envoyée avec la notification.</FormDescription>
          </div>
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )} />
    </section>
  );
}
```

If `bunx shadcn add checkbox` was not run yet, run: `bunx shadcn@latest add checkbox`.

- [ ] **Step 3: SectionBudget**

Create `src/client/components/watch-form/section-budget.tsx`:

```tsx
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { useFormContext } from "react-hook-form";

export function SectionBudget() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Budget LLM</h3>
      <FormField control={f.control} name="budget.max_cost_usd_per_day" render={({ field }) => (
        <FormItem>
          <FormLabel>Budget max par jour (USD)</FormLabel>
          <FormControl>
            <Input type="number" step="0.01" {...field}
              value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)} />
          </FormControl>
          <FormDescription>Au-dessus, la watch se met en pause automatiquement.</FormDescription>
          <FormMessage />
        </FormItem>
      )} />
    </section>
  );
}
```

- [ ] **Step 4: SectionAdvanced (collapsed)**

Create `src/client/components/watch-form/section-advanced.tsx`:

```tsx
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@client/components/ui/accordion";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { Switch } from "@client/components/ui/switch";
import { useFormContext } from "react-hook-form";

export function SectionAdvanced() {
  const f = useFormContext();
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="advanced">
        <AccordionTrigger>Réglages avancés</AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">

          <FormField control={f.control} name="pre_filter.enabled" render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <FormLabel>Pré-filtre statistique</FormLabel>
                <FormDescription>Skip les ticks où ATR / volume / RSI ne montrent rien d'intéressant.</FormDescription>
              </div>
              <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
            </FormItem>
          )} />

          <FormField control={f.control} name="setup_lifecycle.score_initial" render={({ field }) => (
            <FormItem>
              <FormLabel>Score initial à la création</FormLabel>
              <FormControl><Input type="number" min={0} max={100} {...field} onChange={(e) => field.onChange(Number(e.target.value))} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={f.control} name="setup_lifecycle.score_threshold_dead" render={({ field }) => (
            <FormItem>
              <FormLabel>Seuil de mort prématurée</FormLabel>
              <FormControl><Input type="number" min={0} max={100} {...field} onChange={(e) => field.onChange(Number(e.target.value))} /></FormControl>
              <FormDescription>Au-dessous, le setup est considéré perdu.</FormDescription>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={f.control} name="optimization.reviewer_skip_when_detector_corroborated" render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <FormLabel>Skip Reviewer si Detector corrobore</FormLabel>
                <FormDescription>Économise un appel LLM quand le Detector renforce de lui-même.</FormDescription>
              </div>
              <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
            </FormItem>
          )} />

        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
```

- [ ] **Step 5: Wire all sections into the form**

Replace `src/client/components/watch-form/index.tsx` (replace the JSX inside `<form>`):

```tsx
import { SectionAdvanced } from "@client/components/watch-form/section-advanced";
import { SectionAnalyzers } from "@client/components/watch-form/section-analyzers";
import { SectionAsset } from "@client/components/watch-form/section-asset";
import { SectionBudget } from "@client/components/watch-form/section-budget";
import { SectionLifecycle } from "@client/components/watch-form/section-lifecycle";
import { SectionNotifications } from "@client/components/watch-form/section-notifications";
import { SectionSchedule } from "@client/components/watch-form/section-schedule";
// ...existing imports

// inside <form>:
<SectionAsset />
<SectionSchedule />
<SectionLifecycle />
<SectionAnalyzers />
<SectionNotifications />
<SectionBudget />
<SectionAdvanced />
```

- [ ] **Step 6: Commit**

```bash
git add src/client/components/watch-form/
git commit -m "feat(tf-web): WatchForm sections — analyzers, notifications, budget, advanced

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 32: Watch create / edit / delete routes

**Files:**
- Replace: `src/client/routes/watch-new.tsx`, `src/client/routes/watch.tsx`

- [ ] **Step 1: WatchNew route**

Replace `src/client/routes/watch-new.tsx`:

```tsx
import { WatchForm } from "@client/components/watch-form";
import { api } from "@client/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WatchConfig } from "@domain/schemas/Config";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

export function Component() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const create = useMutation({
    mutationFn: (config: WatchConfig) => api("/api/watches", { method: "POST", body: JSON.stringify(config) }),
    onSuccess: (_d, config) => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      toast.success("Watch créée");
      nav(`/watches/${(config as WatchConfig).id}`);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">Nouvelle watch</h1>
      <WatchForm mode="create" onSubmit={(c) => create.mutate(c)} />
    </div>
  );
}
```

- [ ] **Step 2: WatchDetail route (edit + delete)**

Replace `src/client/routes/watch.tsx`:

```tsx
import { Button } from "@client/components/ui/button";
import { ConfirmAction } from "@client/components/shared/confirm-action";
import { WatchForm } from "@client/components/watch-form";
import { api } from "@client/lib/api";
import type { WatchConfig } from "@domain/schemas/Config";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

type WatchDetail = {
  id: string; enabled: boolean; version: number;
  config: WatchConfig;
  state: { lastTickAt: string | null } | null;
};

export function Component() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: ["watches", id],
    queryFn: () => api<WatchDetail>(`/api/watches/${id}`),
  });

  const update = useMutation({
    mutationFn: (config: WatchConfig) =>
      api(`/api/watches/${id}`, {
        method: "PUT",
        body: JSON.stringify({ config, version: detail.data!.version }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      qc.invalidateQueries({ queryKey: ["watches", id] });
      toast.success("Watch mise à jour");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const del = useMutation({
    mutationFn: () => api(`/api/watches/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["watches"] });
      toast.success("Watch supprimée");
      nav("/");
    },
  });

  if (detail.isLoading) return <div>Chargement…</div>;
  if (detail.error || !detail.data) return <div>Erreur</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">Watch — {detail.data.id}</h1>
        <ConfirmAction
          title={`Supprimer ${detail.data.id} ?`}
          description="Les workflows Temporal sont arrêtés. Les setups historiques restent en DB."
          trigger={<Button variant="destructive">Supprimer</Button>}
          onConfirm={() => del.mutate()}
          destructive
        />
      </div>
      <WatchForm mode="edit" initial={detail.data.config} onSubmit={(c) => update.mutate(c)} />
    </div>
  );
}
```

- [ ] **Step 3: Smoke-test**

Boot, visit `/watches/new`, fill the form, submit. Confirm redirect to `/watches/<id>` and the new card appears on `/`. Edit a field, save, confirm version bumps. Delete, confirm redirect to `/`.

- [ ] **Step 4: Commit**

```bash
git add src/client/routes/watch-new.tsx src/client/routes/watch.tsx
git commit -m "feat(tf-web): watch create + edit + delete routes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 9 — Setup detail

### Task 33: TVChart component (lightweight-charts)

**Files:**
- Create: `src/client/components/setup/tv-chart.tsx`

- [ ] **Step 1: Implement the chart wrapper**

Create `src/client/components/setup/tv-chart.tsx`:

```tsx
import { createChart, type IChartApi, type ISeriesApi, type Time } from "lightweight-charts";
import { useEffect, useRef } from "react";

export type Candle = { time: Time; open: number; high: number; low: number; close: number };
export type Level = { price: number; label: string; color: string };

export function TVChart(props: { candles: Candle[]; levels: Level[]; onTimeClick?: (time: Time) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<ReturnType<NonNullable<typeof seriesRef.current>["createPriceLine"]>[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "transparent" }, textColor: "rgb(229, 231, 235)" },
      grid: { vertLines: { color: "rgba(60, 64, 72, 0.4)" }, horzLines: { color: "rgba(60, 64, 72, 0.4)" } },
      timeScale: { timeVisible: true, secondsVisible: false },
      width: containerRef.current.clientWidth,
      height: 360,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#10b981", downColor: "#ef4444",
      borderUpColor: "#10b981", borderDownColor: "#ef4444",
      wickUpColor: "#10b981", wickDownColor: "#ef4444",
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);

    if (props.onTimeClick) {
      chart.subscribeClick((p) => { if (p.time) props.onTimeClick!(p.time); });
    }

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.setData(props.candles);
  }, [props.candles]);

  useEffect(() => {
    if (!seriesRef.current) return;
    for (const line of linesRef.current) seriesRef.current.removePriceLine(line);
    linesRef.current = props.levels.map((lvl) =>
      seriesRef.current!.createPriceLine({
        price: lvl.price, color: lvl.color, lineWidth: 1,
        lineStyle: 2, axisLabelVisible: true, title: lvl.label,
      })
    );
  }, [props.levels]);

  return <div ref={containerRef} className="w-full bg-card border border-border rounded-md overflow-hidden" />;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/components/setup/tv-chart.tsx
git commit -m "feat(tf-web): TVChart wrapper around lightweight-charts with horizontal levels

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 34: ScoreChart component (shadcn Chart / Recharts)

**Files:**
- Create: `src/client/components/setup/score-chart.tsx`

- [ ] **Step 1: Implement**

Create `src/client/components/setup/score-chart.tsx`:

```tsx
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@client/components/ui/chart";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

const chartConfig = {
  score: { label: "Score", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function ScoreChart(props: { points: { occurredAt: string; scoreAfter: number }[] }) {
  const data = props.points.map((p) => ({
    time: new Date(p.occurredAt).toLocaleTimeString(),
    score: p.scoreAfter,
  }));
  return (
    <ChartContainer config={chartConfig} className="h-[120px] w-full">
      <LineChart data={data} margin={{ left: 4, right: 4, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.2} />
        <XAxis dataKey="time" tickLine={false} axisLine={false} fontSize={10} />
        <YAxis domain={[0, 100]} tickLine={false} axisLine={false} fontSize={10} width={28} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line type="monotone" dataKey="score" stroke="var(--color-score)" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ChartContainer>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/client/components/setup/score-chart.tsx
git commit -m "feat(tf-web): ScoreChart on shadcn Chart

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 35: EventsTimeline + KeyLevels + SetupDetail route assembly

**Files:**
- Create: `src/client/components/setup/events-timeline.tsx`, `src/client/components/setup/key-levels.tsx`
- Replace: `src/client/routes/setup.tsx`
- Test: `test/client/frontend/components/events-timeline.test.ts`

- [ ] **Step 1: Test the events timeline expand behavior**

Create `test/client/frontend/components/events-timeline.test.ts`:

```ts
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventsTimeline } from "@client/components/setup/events-timeline";
import { describe, expect, test } from "bun:test";

const events = [
  {
    id: "e1", sequence: 1, occurredAt: new Date().toISOString(),
    type: "Strengthened", scoreAfter: "67", scoreDelta: "12",
    statusBefore: "REVIEWING", statusAfter: "REVIEWING",
    payload: { type: "Strengthened", data: { reasoning: "Hidden reasoning text", observations: [], source: "reviewer_full" } },
    provider: "claude_max", model: "claude-haiku-4-5",
    costUsd: "0.04", latencyMs: 2100,
  },
];

describe("EventsTimeline", () => {
  test("clicking a row reveals reasoning", async () => {
    render(<EventsTimeline events={events} />);
    expect(screen.queryByText("Hidden reasoning text")).toBeNull();
    await userEvent.click(screen.getByText("Strengthened"));
    expect(screen.getByText("Hidden reasoning text")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement `events-timeline.tsx`**

Create `src/client/components/setup/events-timeline.tsx`:

```tsx
import { Badge } from "@client/components/ui/badge";
import { useState } from "react";

export type SetupEvent = {
  id: string;
  sequence: number;
  occurredAt: string;
  type: string;
  scoreDelta: string;
  scoreAfter: string;
  statusBefore: string;
  statusAfter: string;
  payload: { type: string; data: { reasoning?: string; observations?: string[]; freshDataSummary?: { lastClose: number; candlesSinceCreation: number } } };
  provider: string | null;
  model: string | null;
  costUsd: string | null;
  latencyMs: number | null;
};

const variantFor = (type: string): "default" | "secondary" | "destructive" => {
  if (["Strengthened", "Confirmed", "TPHit", "EntryFilled"].includes(type)) return "default";
  if (["Weakened", "Invalidated", "Rejected", "SLHit", "Expired", "PriceInvalidated"].includes(type)) return "destructive";
  return "secondary";
};

export function EventsTimeline({ events }: { events: SetupEvent[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      {events.map((e) => {
        const open = openId === e.id;
        return (
          <div
            key={e.id}
            className={`border-b border-border py-2 cursor-pointer ${open ? "bg-card -mx-2 px-2 rounded" : ""}`}
            onClick={() => setOpenId(open ? null : e.id)}
          >
            <div className="flex items-center gap-3 text-xs">
              <span className="text-muted-foreground font-mono">
                {new Date(e.occurredAt).toLocaleTimeString("fr-FR", { hour12: false })}
              </span>
              <Badge variant={variantFor(e.type)}>{e.type}</Badge>
              <span className="font-mono ml-auto">
                {Number(e.scoreDelta) !== 0 && (Number(e.scoreDelta) > 0 ? "+" : "")}
                {Number(e.scoreDelta) !== 0 ? Number(e.scoreDelta).toFixed(0) : ""} → {Number(e.scoreAfter).toFixed(0)}
              </span>
            </div>
            {e.provider && (
              <div className="text-[10px] text-muted-foreground font-mono mt-1 ml-1">
                {e.provider} · {e.model} · ${Number(e.costUsd ?? 0).toFixed(2)} · {e.latencyMs}ms
              </div>
            )}
            {open && e.payload?.data?.reasoning && (
              <div className="mt-2 p-3 bg-background rounded border border-primary/30 text-xs space-y-2">
                <div>
                  <p className="font-bold text-muted-foreground uppercase tracking-wide text-[10px] mb-1">Raisonnement</p>
                  <p className="text-foreground/90 leading-relaxed">{e.payload.data.reasoning}</p>
                </div>
                {e.payload.data.observations && e.payload.data.observations.length > 0 && (
                  <div>
                    <p className="font-bold text-muted-foreground uppercase tracking-wide text-[10px] mb-1">Observations</p>
                    <ul className="space-y-1">
                      {e.payload.data.observations.map((o, i) => (
                        <li key={i} className="border-l-2 border-primary pl-2 text-[11px]">{o}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {e.payload.data.freshDataSummary && (
                  <div>
                    <p className="font-bold text-muted-foreground uppercase tracking-wide text-[10px] mb-1">Données fraîches</p>
                    <p className="font-mono text-[11px]">
                      Last close: {e.payload.data.freshDataSummary.lastClose} ·
                      Candles since creation: {e.payload.data.freshDataSummary.candlesSinceCreation}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Implement `key-levels.tsx`**

Create `src/client/components/setup/key-levels.tsx`:

```tsx
export function KeyLevels(props: {
  entry?: number | null; sl?: number | null;
  tp?: number[]; invalidation?: number | null;
}) {
  const cell = (label: string, val: number | null | undefined) => (
    <div className="border border-border rounded px-3 py-1.5 font-mono text-xs bg-card">
      <span className="text-[9px] uppercase text-muted-foreground mr-2">{label}</span>
      {val ?? "—"}
    </div>
  );
  return (
    <div className="flex flex-wrap gap-2">
      {cell("Entry", props.entry)}
      {cell("SL", props.sl)}
      {props.tp?.map((p, i) => <div key={i}>{cell(`TP${i + 1}`, p)}</div>)}
      {cell("Invalidation", props.invalidation)}
    </div>
  );
}
```

- [ ] **Step 4: SetupDetail route**

Replace `src/client/routes/setup.tsx`:

```tsx
import { Badge } from "@client/components/ui/badge";
import { Button } from "@client/components/ui/button";
import { ConfirmAction } from "@client/components/shared/confirm-action";
import { EventsTimeline, type SetupEvent } from "@client/components/setup/events-timeline";
import { KeyLevels } from "@client/components/setup/key-levels";
import { ScoreChart } from "@client/components/setup/score-chart";
import { TVChart, type Candle, type Level } from "@client/components/setup/tv-chart";
import { useAdminAction } from "@client/hooks/useAdminAction";
import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

type Setup = {
  id: string; watchId: string; asset: string; timeframe: string; status: string;
  currentScore: string; patternHint: string | null; direction: "LONG" | "SHORT" | null;
  invalidationLevel: string | null; ttlExpiresAt: string;
};

export function Component() {
  const { id } = useParams<{ id: string }>();
  const { killSetup } = useAdminAction();

  const setup = useQuery({
    queryKey: ["setups", id],
    queryFn: () => api<Setup>(`/api/setups/${id}`),
  });
  const events = useQuery({
    queryKey: ["setups", id, "events"],
    queryFn: () => api<SetupEvent[]>(`/api/setups/${id}/events`),
  });
  const ohlcv = useQuery({
    queryKey: ["setups", id, "ohlcv"],
    queryFn: () => api<Candle[]>(`/api/setups/${id}/ohlcv`),
    staleTime: 60_000,
  });

  if (setup.isLoading) return <div>Chargement…</div>;
  if (setup.error || !setup.data) return <div>Erreur</div>;

  const confirmedPayload = events.data?.findLast?.((e) => e.type === "Confirmed")?.payload?.data as
    | { entry?: number; stopLoss?: number; takeProfit?: number[] }
    | undefined;

  const levels: Level[] = [
    confirmedPayload?.entry && { price: confirmedPayload.entry, label: "Entry", color: "#60a5fa" },
    confirmedPayload?.stopLoss && { price: confirmedPayload.stopLoss, label: "SL", color: "#f87171" },
    setup.data.invalidationLevel && { price: Number(setup.data.invalidationLevel), label: "Invalidation", color: "#9ca3af" },
    ...(confirmedPayload?.takeProfit ?? []).map((p, i) => ({ price: p, label: `TP${i + 1}`, color: "#34d399" })),
  ].filter(Boolean) as Level[];

  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-3">
        <Link to={`/watches/${setup.data.watchId}`} className="text-sm text-muted-foreground">
          ← {setup.data.watchId}
        </Link>
        <h1 className="text-xl font-bold font-mono">{setup.data.asset} {setup.data.timeframe}</h1>
        {setup.data.patternHint && <span className="text-muted-foreground">{setup.data.patternHint}</span>}
        {setup.data.direction && (
          <Badge variant={setup.data.direction === "LONG" ? "default" : "destructive"}>{setup.data.direction}</Badge>
        )}
        <Badge variant="secondary">{setup.data.status}</Badge>
        <ConfirmAction
          title={`Tuer le setup ${setup.data.id.slice(0, 8)} ?`}
          description="Le workflow Setup est terminé. L'historique reste en DB."
          trigger={<Button size="sm" variant="destructive" className="ml-auto">Kill setup</Button>}
          onConfirm={() => killSetup.mutate({ setupId: id! })}
          destructive
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6">
        <div className="space-y-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Chart</h3>
          {ohlcv.data ? (
            <TVChart candles={ohlcv.data} levels={levels} />
          ) : (
            <div className="h-[360px] bg-card border border-border rounded-md grid place-items-center text-muted-foreground">
              {ohlcv.isLoading ? "Chargement OHLCV…" : "Pas de données OHLCV"}
            </div>
          )}
          <KeyLevels
            entry={confirmedPayload?.entry}
            sl={confirmedPayload?.stopLoss}
            tp={confirmedPayload?.takeProfit}
            invalidation={setup.data.invalidationLevel ? Number(setup.data.invalidationLevel) : null}
          />
        </div>

        <div className="space-y-4">
          <div>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Évolution du score</h3>
            {events.data && events.data.length > 0 ? (
              <ScoreChart points={events.data.map((e) => ({ occurredAt: e.occurredAt, scoreAfter: Number(e.scoreAfter) }))} />
            ) : <div className="text-xs text-muted-foreground">Pas encore d'événements.</div>}
          </div>
          <div>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Événements ({events.data?.length ?? 0})</h3>
            <EventsTimeline events={events.data ?? []} />
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run + commit**

Run: `bun test test/client/frontend/components/events-timeline.test.ts`
Expected: 1 test passes.

```bash
git add src/client/components/setup/ src/client/routes/setup.tsx test/client/frontend/components/events-timeline.test.ts
git commit -m "feat(tf-web): Setup detail with TVChart + ScoreChart + events timeline

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 10 — Live events sidebar + costs

### Task 36: LiveEventsSidebar + EventDetailModal

**Files:**
- Create: `src/client/components/live-events-sidebar.tsx`, `src/client/components/event-detail-modal.tsx`
- Modify: `src/client/routes/root.tsx`

- [ ] **Step 1: EventDetailModal**

Create `src/client/components/event-detail-modal.tsx`:

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@client/components/ui/dialog";
import type { SetupEvent } from "@client/components/setup/events-timeline";
import { Link } from "react-router-dom";

export function EventDetailModal(props: {
  event: (SetupEvent & { setupId: string; watchId?: string }) | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!props.event} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {props.event?.type} — {props.event && new Date(props.event.occurredAt).toLocaleString("fr-FR")}
          </DialogTitle>
        </DialogHeader>
        {props.event && (
          <div className="space-y-4 text-sm">
            <p className="font-mono text-xs">
              {props.event.provider} · {props.event.model} · ${Number(props.event.costUsd ?? 0).toFixed(2)} · {props.event.latencyMs}ms
            </p>
            <p>
              Score : <span className="font-mono">{Number(props.event.scoreAfter).toFixed(0)}</span>
              {Number(props.event.scoreDelta) !== 0 && (
                <span className="text-muted-foreground ml-2">
                  ({Number(props.event.scoreDelta) > 0 ? "+" : ""}{Number(props.event.scoreDelta).toFixed(0)})
                </span>
              )}
            </p>
            {props.event.payload?.data?.reasoning && (
              <div>
                <p className="font-bold text-xs uppercase text-muted-foreground mb-1">Raisonnement</p>
                <p className="leading-relaxed">{props.event.payload.data.reasoning}</p>
              </div>
            )}
            {props.event.payload?.data?.observations && props.event.payload.data.observations.length > 0 && (
              <div>
                <p className="font-bold text-xs uppercase text-muted-foreground mb-1">Observations</p>
                <ul className="space-y-1">
                  {props.event.payload.data.observations.map((o, i) => (
                    <li key={i} className="border-l-2 border-primary pl-2">{o}</li>
                  ))}
                </ul>
              </div>
            )}
            <Link
              to={`/setups/${props.event.setupId}`}
              className="text-primary text-xs hover:underline block"
              onClick={props.onClose}
            >
              Voir le setup complet →
            </Link>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: LiveEventsSidebar**

Create `src/client/components/live-events-sidebar.tsx`:

```tsx
import { EventDetailModal } from "@client/components/event-detail-modal";
import type { SetupEvent } from "@client/components/setup/events-timeline";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

type LiveEvent = SetupEvent & { setupId: string; watchId?: string };

export function LiveEventsSidebar() {
  const { data = [] } = useQuery<LiveEvent[]>({
    queryKey: ["events", "live"],
    queryFn: async () => [],
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [selected, setSelected] = useState<LiveEvent | null>(null);

  return (
    <div className="text-xs space-y-1">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Live events</h4>
      {data.length === 0 && <p className="text-muted-foreground italic">En attente d'événements…</p>}
      {data.map((e) => (
        <button
          key={e.id}
          onClick={() => setSelected(e)}
          className="w-full text-left border-b border-dashed border-border py-2 hover:bg-card rounded px-1"
        >
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground font-mono text-[10px]">
              {new Date(e.occurredAt).toLocaleTimeString("fr-FR", { hour12: false })}
            </span>
            {e.watchId && <span className="text-primary font-mono text-[10px]">{e.watchId}</span>}
            <span className="font-bold">{e.type}</span>
            <span className="ml-auto font-mono">{Number(e.scoreAfter).toFixed(0)}</span>
          </div>
        </button>
      ))}
      <EventDetailModal event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
```

- [ ] **Step 3: Wire LiveEventsSidebar into RootLayout**

Replace the placeholder import in `src/client/routes/root.tsx`:

```tsx
import { LiveEventsSidebar } from "@client/components/live-events-sidebar";
// remove the local placeholder function
```

And inside `<aside>`:

```tsx
<LiveEventsSidebar />
```

- [ ] **Step 4: Commit**

```bash
git add src/client/components/live-events-sidebar.tsx src/client/components/event-detail-modal.tsx src/client/routes/root.tsx
git commit -m "feat(tf-web): live events sidebar + clickable event detail modal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 37: Live events full route + Costs route

**Files:**
- Replace: `src/client/routes/live-events.tsx`, `src/client/routes/costs.tsx`

- [ ] **Step 1: Live events full screen**

Replace `src/client/routes/live-events.tsx`:

```tsx
import { EventDetailModal } from "@client/components/event-detail-modal";
import { Badge } from "@client/components/ui/badge";
import type { SetupEvent } from "@client/components/setup/events-timeline";
import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

type LiveEvent = SetupEvent & { setupId: string; watchId?: string };

export function Component() {
  const [selected, setSelected] = useState<LiveEvent | null>(null);
  const recent = useQuery({
    queryKey: ["events"],
    queryFn: () => api<LiveEvent[]>("/api/events?limit=200"),
    staleTime: 2_000,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Flux d'événements</h1>
      <div className="space-y-1">
        {(recent.data ?? []).map((e) => (
          <button
            key={e.id}
            onClick={() => setSelected(e)}
            className="w-full text-left flex items-center gap-3 border-b border-border py-2 hover:bg-card rounded px-2 text-sm"
          >
            <span className="text-muted-foreground font-mono text-xs w-24">
              {new Date(e.occurredAt).toLocaleString("fr-FR")}
            </span>
            <Badge variant="secondary" className="w-24 justify-center font-mono">{e.watchId}</Badge>
            <span className="font-bold w-32">{e.type}</span>
            <span className="text-muted-foreground text-xs">{e.provider} · {e.model}</span>
            <span className="ml-auto font-mono text-xs">${Number(e.costUsd ?? 0).toFixed(2)}</span>
            <span className="font-mono w-16 text-right">{Number(e.scoreAfter).toFixed(0)}</span>
          </button>
        ))}
      </div>
      <EventDetailModal event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
```

- [ ] **Step 2: Costs route**

Replace `src/client/routes/costs.tsx`:

```tsx
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@client/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@client/components/ui/tabs";
import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

type Aggregation = { key: string; totalUsd: number; count: number };
const config = { totalUsd: { label: "USD", color: "var(--chart-1)" } } satisfies ChartConfig;

export function Component() {
  const [groupBy, setGroupBy] = useState<"watch" | "provider" | "model" | "day">("watch");
  const { data = [] } = useQuery({
    queryKey: ["costs", { groupBy }],
    queryFn: () => api<Aggregation[]>(`/api/costs?groupBy=${groupBy}`),
    staleTime: 60_000,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Coûts LLM</h1>
      <Tabs value={groupBy} onValueChange={(v) => setGroupBy(v as typeof groupBy)}>
        <TabsList>
          <TabsTrigger value="watch">Par watch</TabsTrigger>
          <TabsTrigger value="provider">Par provider</TabsTrigger>
          <TabsTrigger value="model">Par modèle</TabsTrigger>
          <TabsTrigger value="day">Par jour</TabsTrigger>
        </TabsList>
      </Tabs>
      <ChartContainer config={config} className="h-[300px] w-full">
        <BarChart data={data}>
          <CartesianGrid vertical={false} strokeOpacity={0.2} />
          <XAxis dataKey="key" fontSize={11} />
          <YAxis fontSize={11} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="totalUsd" fill="var(--color-totalUsd)" radius={4} />
        </BarChart>
      </ChartContainer>
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground text-xs">
          <tr><th className="py-2">Clé</th><th>Total</th><th>Calls</th></tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.key} className="border-t border-border">
              <td className="py-2 font-mono">{row.key}</td>
              <td className="font-mono">${row.totalUsd.toFixed(2)}</td>
              <td className="font-mono">{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/client/routes/live-events.tsx src/client/routes/costs.tsx
git commit -m "feat(tf-web): live events full route + costs page with grouping tabs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 11 — Docker integration + README

### Task 38: Add `tf-web` service to `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Append the `tf-web` service**

Open `docker-compose.yml` and add at the bottom of `services:` (before the `volumes:` block):

```yaml
  tf-web:
    build: { context: ., dockerfile: docker/Dockerfile.worker }
    container_name: tf-web
    restart: unless-stopped
    depends_on:
      bootstrap-schedules:
        condition: service_completed_successfully
    environment:
      <<: *worker_env
      WEB_PORT: "8084"
      NODE_ENV: production
      TF_WEB_POLL_INTERVAL_MS: "1500"
      TF_WEB_POLL_BATCH_SIZE: "200"
      ARTIFACTS_BASE_DIR: "/data/artifacts"
    volumes:
      - ./config:/app/config:ro
      - ./prompts:/app/prompts:ro
      - artifacts_data:/data/artifacts:ro
    command: bun run src/client/server.ts
    ports:
      - "127.0.0.1:8084:8084"
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O - http://localhost:8084/health || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 20s
```

- [ ] **Step 2: Validate the compose file syntactically**

Run: `docker compose config > /dev/null`
Expected: zero output (no errors). If errors, fix YAML indentation.

- [ ] **Step 3: Boot and verify**

Run: `docker compose up -d --build tf-web`
Wait ~30s, then: `curl -s http://localhost:8084/health`
Expected: `{"component":"tf-web","status":"ok",...}`

Open `http://localhost:8084/` in a browser. Confirm the app shell renders.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(docker): add tf-web service on :8084 (localhost-bound)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 39: Update `README.md` with the new UI section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a new section after "Getting Started"**

Insert after step 6 ("Vérifier que le pipeline tourne") in `README.md`:

```markdown
### 7. Ouvrir l'UI Trader (`tf-web`)

Une fois la stack démarrée, l'interface trader est disponible sur :

```
http://localhost:8084
```

Tu y configures tes watches (création / édition / pause / suppression) et tu monitores les setups en cours en temps réel : score qui évolue, events au fil de l'eau, chart interactif par setup, coûts LLM agrégés.

**Architecture** : `tf-web` lit / écrit la table Postgres `watch_configs` (la source de vérité pour les watches[]). Le `watches.yaml` continue de fournir l'infra globale (`llm_providers`, `notifications.telegram`, `database`, `temporal`, `market_data`).

**Migration depuis un `watches.yaml` existant** (one-shot, optionnel) :

```bash
bun run src/cli/seed-watches-from-yaml.ts
```

Idempotent : skippe les watches déjà présentes en DB. Documente bien tes équivalents avant de bidouiller.
```

- [ ] **Step 2: Update the "Architecture" diagram**

Find the architecture block in `README.md` and add the new container. Replace the worker grid with:

```
│   ┌───────────────┐  ┌───────────────┐  ┌──────────────────┐  ┌──────────┐  │
│   │ scheduler     │  │ analysis      │  │ notification     │  │ tf-web   │  │
│   │ worker :8081  │  │ worker :8082  │  │ worker :8083     │  │ :8084    │  │
│   └───────────────┘  └───────────────┘  └──────────────────┘  └──────────┘  │
```

Add `8084 — tf-web /api + UI` to the "Ports utilisés" list.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document the tf-web UI on :8084 and yaml→DB migration

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 12 — E2E smoke test

### Task 40: Playwright smoke test against running compose

**Files:**
- Create: `test/e2e/web-smoke.test.ts`

- [ ] **Step 1: Implement the smoke test**

Create `test/e2e/web-smoke.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { chromium } from "playwright";

const URL = process.env.TF_WEB_URL ?? "http://localhost:8084";
const RUN = process.env.RUN_E2E === "1";

const maybe = RUN ? describe : describe.skip;

maybe("tf-web e2e smoke", () => {
  test("loads dashboard, creates a watch, opens setup if any", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      await page.goto(URL, { waitUntil: "networkidle" });
      await expect(page.getByText(/dashboard/i)).toBeVisible();

      await page.getByRole("link", { name: /nouvelle watch|créer la première watch/i }).first().click();
      await page.fill('input[name="id"]', `e2e-${Date.now()}`);
      await page.fill('input[name="asset.symbol"]', "BTCUSDT");

      await page.locator("button[role='combobox']").first().click();
      await page.getByText("binance").click();

      await page.fill('input[name="notifications.telegram_chat_id"]', "111");

      await page.getByRole("button", { name: /créer la watch/i }).click();
      await page.waitForURL(/\/watches\//);
      await expect(page.getByText(/watch — e2e-/i)).toBeVisible();
    } finally {
      await browser.close();
    }
  }, 60_000);
});
```

- [ ] **Step 2: Add the script**

Edit `package.json` `scripts`:

```json
"test:e2e:web": "RUN_E2E=1 bun test test/e2e/web-smoke.test.ts"
```

- [ ] **Step 3: Run it locally with the stack up**

```bash
docker compose up -d --build
bun run test:e2e:web
```

Expected: 1 test passes within ~60s.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/web-smoke.test.ts package.json
git commit -m "test(e2e): Playwright smoke test for tf-web UI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review checklist (run before declaring done)

- [ ] Run all unit + integration tests: `bun test`. Expected: all green except gated suites.
- [ ] Run client tests: `bun test test/client`. Expected: all green.
- [ ] Boot full stack: `docker compose up -d --build`. Verify all containers healthy after ~60s.
- [ ] Visit `http://localhost:8084/`, create a watch, observe the live event stream populate when ticks fire.
- [ ] Edit a watch, observe version bumps; deliberately try a stale-version edit via API to verify 409 surfaces.
- [ ] Delete a watch, verify Temporal Schedule + workflows are gone (`docker compose logs scheduler-worker`).
- [ ] Run E2E smoke: `bun run test:e2e:web`.
- [ ] Verify `bunx drizzle-kit studio` shows `watch_configs` and `watch_config_revisions` tables populated correctly.

## Spec coverage map

| Spec section | Tasks |
|---|---|
| D1 — Watches[] in DB | 1, 2, 7 |
| D2 — Single tf-web container | 8–11, 38 |
| D3 — SSE + DB polling | 21, 22, 23 |
| D4 — Form trader-friendly | 30, 31 |
| D5 — 4 pages + Live events + admin | 29, 32, 35, 36, 37 |
| D6 — Sidebar + event modal | 36, 37 |
| D7 — Setup detail 2-col + lightweight-charts | 33, 34, 35 |
| D8 — shadcn + Tailwind v4 | 24, 25 |
| Touch points (refactor CLIs) | 3–6 |
| Concurrency (version) | 12, 13, 14 |
| Latency budget | inherent in 22, 23 |
| Docker boot order | 38 |
| Testing strategy | tests bundled into each task + 40 |








