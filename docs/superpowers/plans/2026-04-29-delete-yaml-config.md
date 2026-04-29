# Delete YAML config — DB as the only admin surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the `config/watches.yaml` loading path entirely. Make `watch_configs` (Postgres) the only admin surface. Workers boot, register with Temporal, and pick up the schedule backlog.

**Architecture:** Pure deletion + small re-wire. No DB schema changes, no new env vars, no new abstractions. Things that lived in YAML go where they're consumed: provider catalog → constant in `buildProviderRegistry.ts`, `market_data` whitelist → derived from watches, `notifications.telegram` opt-in → implicit (env-driven), retention thresholds → never actually consumed (only declared in the YAML schema), no constants needed.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, Temporal, Zod, Postgres.

**Spec:** `docs/superpowers/specs/2026-04-29-delete-yaml-config-design.md`

**Ordering principle:** Each task ends with a codebase that compiles. Old code paths stay alive until their callers have migrated; deletion of obsolete files happens once nothing references them; the schema is stripped last.

---

## File Structure

**Files deleted (8):**
- `src/config/loadWatchesConfig.ts`
- `src/cli/seed-watches-from-yaml.ts`
- `src/cli/seedWatchesFromYaml.lib.ts`
- `src/cli/reload-config.ts`
- `config/watches.yaml.example` (and the `config/` directory)
- `test/config/loadWatchesConfig.test.ts`
- `test/cli/seedWatchesFromYaml.test.ts`
- `test/integration/standby-boot.test.ts`

**Files created (1):**
- `src/config/WatchesConfigError.ts` — relocated error class

**Files modified (12):**
- `src/config/loadWatchesFromDb.ts` — drop the import that's about to be deleted
- `src/adapters/llm/buildProviderRegistry.ts` — drop `watches` arg, hardcode `PROVIDER_DEFAULTS`
- `src/workflows/activityDependencies.ts` — `ActivityDeps.config` becomes `{ watches: WatchConfig[] }`, add `pgPool: pg.Pool`
- `src/domain/schemas/WatchesConfig.ts` — strip down to `WatchSchema` + `NotifyEventSchema` (final task)
- `src/workers/buildContainer.ts` — drop standby branch, derive market_data, drop telegram opt-in branch, expose pool in deps
- `src/workers/scheduler-worker.ts`, `analysis-worker.ts`, `notification-worker.ts` — drop standby + arg parsing, load from DB
- `src/cli/bootstrap-schedules.ts` — load from DB
- `src/workflows/scheduler/activities.ts` — rename `reloadConfigFromDisk` → `reloadConfigFromDb`, body re-reads DB
- `src/workflows/scheduler/schedulerWorkflow.ts` — call site rename
- `docker-compose.yml`, `docker-compose-dev.yaml` — remove `./config:/app/config:ro` mounts
- `test/domain/schemas/WatchesConfig.test.ts` — drop wrapper-schema tests
- `test/adapters/llm/buildProviderRegistry.test.ts` — new signature
- `test/config/loadWatchesFromDb.test.ts` — drop the YAML-mixing branch

---

## Task 1: Extract `WatchesConfigError` into its own module

**Why first:** `loadWatchesConfig.ts` is the current home of `WatchesConfigError`. `loadWatchesFromDb.ts` imports it from there. We need to relocate the class before deleting the file.

**Files:**
- Create: `src/config/WatchesConfigError.ts`
- Modify: `src/config/loadWatchesConfig.ts`
- Modify: `src/config/loadWatchesFromDb.ts`

- [ ] **Step 1: Create the new file**

```ts
// src/config/WatchesConfigError.ts
export class WatchesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchesConfigError";
  }
}
```

- [ ] **Step 2: Update `loadWatchesFromDb.ts` import**

In `src/config/loadWatchesFromDb.ts` line 2, change:
```ts
import { WatchesConfigError } from "@config/loadWatchesConfig";
```
to:
```ts
import { WatchesConfigError } from "@config/WatchesConfigError";
```

- [ ] **Step 3: Update `loadWatchesConfig.ts` to re-export**

In `src/config/loadWatchesConfig.ts`, replace the local class definition (lines 5-10):
```ts
export class WatchesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchesConfigError";
  }
}
```
with:
```ts
export { WatchesConfigError } from "@config/WatchesConfigError";
```
This keeps existing re-imports working until the file is deleted in Task 12.

- [ ] **Step 4: Verify**

Run: `bun run lint && bun test test/config/loadWatchesFromDb.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/WatchesConfigError.ts src/config/loadWatchesConfig.ts src/config/loadWatchesFromDb.ts
git commit -m "refactor(config): extract WatchesConfigError into its own module"
```

---

## Task 2: Hardcode `PROVIDER_DEFAULTS` in `buildProviderRegistry`

**Files:**
- Modify: `src/adapters/llm/buildProviderRegistry.ts`
- Modify: `test/adapters/llm/buildProviderRegistry.test.ts`
- Modify: `src/workers/buildContainer.ts` (call site)

- [ ] **Step 1: Update the test first (TDD)**

Replace the entire content of `test/adapters/llm/buildProviderRegistry.test.ts` with:

```ts
import { expect, test } from "bun:test";
import { buildProviderRegistry } from "@adapters/llm/buildProviderRegistry";
import type { InfraConfig } from "@config/InfraConfig";

const infraStub: InfraConfig = {
  database: { url: "x", pool_size: 1, ssl: false },
  temporal: {
    address: "x",
    namespace: "default",
    task_queues: { scheduler: "s", analysis: "a", notifications: "n" },
  },
  notifications: { telegram: { bot_token: "t", chat_id: "c" } },
  llm: { openrouter_api_key: "k" },
  artifacts: { base_dir: "/tmp" },
  claude: { workspace_dir: "/tmp" },
};

test("builds registry with claude_max + openrouter from hardcoded catalog", () => {
  const registry = buildProviderRegistry(infraStub);
  expect(registry.size).toBe(2);
  expect(registry.get("claude_max")?.fallback).toBe("openrouter");
  expect(registry.get("openrouter")?.fallback).toBeNull();
});

test("openrouter without api_key throws clear error", () => {
  const infraNoKey: InfraConfig = { ...infraStub, llm: { openrouter_api_key: null } };
  expect(() => buildProviderRegistry(infraNoKey)).toThrow(/OPENROUTER_API_KEY/);
});
```

The previous "circular fallback" test is dropped — the catalog is hardcoded and acyclic by construction. Cycle detection itself is unit-tested in `test/domain/services/validateProviderGraph.test.ts` (unchanged).

- [ ] **Step 2: Run test, expect compile failure**

Run: `bun test test/adapters/llm/buildProviderRegistry.test.ts`
Expected: FAIL — `buildProviderRegistry` currently expects `(watches, infra, usageStore)`, not `(infra)`.

- [ ] **Step 3: Replace `buildProviderRegistry.ts`**

Overwrite `src/adapters/llm/buildProviderRegistry.ts` with:

```ts
import type { InfraConfig } from "@config/InfraConfig";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { LLMUsageStore } from "@domain/ports/LLMUsageStore";
import { validateProviderGraph } from "@domain/services/validateProviderGraph";
import { ClaudeAgentSdkProvider } from "./ClaudeAgentSdkProvider";
import { OpenRouterProvider } from "./OpenRouterProvider";

type ProviderDefault =
  | {
      type: "claude-agent-sdk";
      daily_call_budget?: number;
      fallback: string | null;
    }
  | {
      type: "openrouter";
      base_url?: string;
      monthly_budget_usd?: number;
      fallback: string | null;
    };

const PROVIDER_DEFAULTS: Record<string, ProviderDefault> = {
  claude_max: {
    type: "claude-agent-sdk",
    daily_call_budget: 800,
    fallback: "openrouter",
  },
  openrouter: {
    type: "openrouter",
    monthly_budget_usd: 50,
    fallback: null,
  },
};

export function buildProviderRegistry(
  infra: InfraConfig,
  usageStore?: LLMUsageStore,
): Map<string, LLMProvider> {
  const registry = new Map<string, LLMProvider>();

  for (const [name, providerCfg] of Object.entries(PROVIDER_DEFAULTS)) {
    if (providerCfg.type === "claude-agent-sdk") {
      registry.set(
        name,
        new ClaudeAgentSdkProvider(name, {
          workspaceDir: infra.claude.workspace_dir,
          dailyCallBudget: providerCfg.daily_call_budget,
          fallback: providerCfg.fallback,
          usageStore,
        }),
      );
    } else {
      if (infra.llm.openrouter_api_key === null) {
        throw new Error(
          `OPENROUTER_API_KEY is required because provider "${name}" type = openrouter`,
        );
      }
      registry.set(
        name,
        new OpenRouterProvider(name, {
          apiKey: infra.llm.openrouter_api_key,
          baseUrl: providerCfg.base_url,
          monthlyBudgetUsd: providerCfg.monthly_budget_usd,
          fallback: providerCfg.fallback,
          usageStore,
        }),
      );
    }
  }

  // Defense in depth — even if PROVIDER_DEFAULTS is edited badly later
  const graphForValidation: Record<string, { fallback: string | null }> = {};
  for (const [name, p] of registry) graphForValidation[name] = { fallback: p.fallback };
  validateProviderGraph(graphForValidation);

  return registry;
}
```

- [ ] **Step 4: Update the call site in `buildContainer.ts`**

In `src/workers/buildContainer.ts`, find the line (around 122):
```ts
const llmProviders =
  role === "notification"
    ? new Map<string, LLMProvider>()
    : buildProviderRegistry(watches, infra, llmUsageStore);
```
Change to:
```ts
const llmProviders =
  role === "notification"
    ? new Map<string, LLMProvider>()
    : buildProviderRegistry(infra, llmUsageStore);
```

- [ ] **Step 5: Run tests + lint**

Run: `bun run lint && bun test test/adapters/llm/buildProviderRegistry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/llm/buildProviderRegistry.ts src/workers/buildContainer.ts test/adapters/llm/buildProviderRegistry.test.ts
git commit -m "refactor(llm): hardcode provider defaults in registry, drop watches arg"
```

---

## Task 3: Add `pgPool` to `ActivityDeps` and narrow `config` to `{ watches }`

**Why both at once:** Both changes are local edits to `activityDependencies.ts`, both need a one-line fix in `buildContainer.ts`, and committing them together keeps the codebase compiling.

**Files:**
- Modify: `src/workflows/activityDependencies.ts`
- Modify: `src/workers/buildContainer.ts`

- [ ] **Step 1: Edit `activityDependencies.ts`**

Replace the entire content of `src/workflows/activityDependencies.ts` with:

```ts
import type { InfraConfig } from "@config/InfraConfig";
import type { ArtifactStore } from "@domain/ports/ArtifactStore";
import type { ChartRenderer } from "@domain/ports/ChartRenderer";
import type { Clock } from "@domain/ports/Clock";
import type { EventStore } from "@domain/ports/EventStore";
import type { IndicatorCalculator } from "@domain/ports/IndicatorCalculator";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { MarketDataFetcher } from "@domain/ports/MarketDataFetcher";
import type { Notifier } from "@domain/ports/Notifier";
import type { PriceFeed } from "@domain/ports/PriceFeed";
import type { SetupRepository } from "@domain/ports/SetupRepository";
import type { TickSnapshotStore } from "@domain/ports/TickSnapshotStore";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import type { Client } from "@temporalio/client";
import type { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

export type ActivityDeps = {
  marketDataFetchers: Map<string, MarketDataFetcher>;
  chartRenderer: ChartRenderer;
  indicatorCalculator: IndicatorCalculator;
  llmProviders: Map<string, LLMProvider>;
  priceFeeds: Map<string, PriceFeed>;
  notifier: Notifier;
  setupRepo: SetupRepository;
  eventStore: EventStore;
  artifactStore: ArtifactStore;
  tickSnapshotStore: TickSnapshotStore;
  clock: Clock;
  config: { watches: WatchConfig[] };
  infra: InfraConfig;
  watchById: (id: string) => WatchConfig | undefined;
  temporalClient: Client;
  db: ReturnType<typeof drizzle>;
  pgPool: pg.Pool;
};
```

Changes vs before:
- Removed `WatchesConfig` from the type imports (only `WatchConfig` is kept).
- Added `import type pg from "pg";`.
- Narrowed `config` to `{ watches: WatchConfig[] }`.
- Added `pgPool: pg.Pool`.

- [ ] **Step 2: Update `buildContainer.ts` to populate `pgPool` in `deps`**

The current `buildContainer.ts` (around lines 75-100 for the standby branch and lines 161-178 for the active branch) constructs `deps: ActivityDeps` without setting `pgPool`. Add `pgPool: pool,` to BOTH branches.

In the `watches === null` branch (the standby `deps` construction), add the line just before the closing brace, e.g. between `db,` and the closing `};`:

```ts
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
  pgPool: pool,
};
```

In the active branch (around lines 161-178), do the same:
```ts
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
  pgPool: pool,
};
```

Note: `config: null as unknown as WatchesConfig` and `config: watches` (the WatchesConfig wrapper) still type-check because `WatchesConfig` has `watches: WatchConfig[]` plus other fields, which is structurally assignable to `{ watches: WatchConfig[] }`. This is fine — Task 5 will rewrite this whole file and clean it up. We just need it to compile here.

- [ ] **Step 3: Verify**

Run: `bun run lint`
Expected: PASS. Tests should still pass (no behavior change yet).

Run: `bun test`
Expected: PASS (modulo any tests that mock `ActivityDeps` and would need `pgPool` — if any fail, add `pgPool: {} as pg.Pool` or similar to the mock).

- [ ] **Step 4: Commit**

```bash
git add src/workflows/activityDependencies.ts src/workers/buildContainer.ts
git commit -m "refactor(deps): narrow ActivityDeps.config and expose pgPool"
```

---

## Task 4: Rename `reloadConfigFromDisk` → `reloadConfigFromDb`

**Files:**
- Modify: `src/workflows/scheduler/activities.ts`
- Modify: `src/workflows/scheduler/schedulerWorkflow.ts`

- [ ] **Step 1: Update the activity body**

In `src/workflows/scheduler/activities.ts`:

Top of file, replace the import:
```ts
import { loadWatchesConfig } from "@config/loadWatchesConfig";
```
with:
```ts
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
```

Find lines 243-253 (the `reloadConfigFromDisk` activity) and replace with:
```ts
async reloadConfigFromDb(_input: Record<string, never>): Promise<{ reloaded: boolean }> {
  const watches = await loadWatchesFromDb(deps.pgPool);
  // Mutate the captured config object in place so the watchById closure
  // and any other references see the new data without rebuilding deps.
  deps.config.watches.length = 0;
  for (const w of watches) deps.config.watches.push(w);
  return { reloaded: true };
},
```

- [ ] **Step 2: Update workflow call site**

In `src/workflows/scheduler/schedulerWorkflow.ts`, find line 96:
```ts
await dbActivities.reloadConfigFromDisk({});
```
Change to:
```ts
await dbActivities.reloadConfigFromDb({});
```

Also update the comment block above the call (lines 91-95) to reflect the DB origin:
```ts
setHandler(reloadConfigSignal, async () => {
  // Reload watches from Postgres and mutate the worker-level config in
  // place, so subsequent activity invocations (which call
  // `deps.watchById`) see the new data. Note: changes to `temporal.address`
  // or schedule cron require a worker restart or a Schedule update — they
  // are not picked up here.
  await dbActivities.reloadConfigFromDb({});
});
```

- [ ] **Step 3: Run lint + targeted tests**

Run: `bun run lint`
Expected: PASS.

Run: `bun test test/workflows`
Expected: PASS, or FAIL with a clear "method not found" if a test mocked `reloadConfigFromDisk` by name. If so, update the mock to use the new name and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/workflows/scheduler/activities.ts src/workflows/scheduler/schedulerWorkflow.ts
git commit -m "refactor(scheduler): rename reloadConfigFromDisk to reloadConfigFromDb"
```

---

## Task 5: Rewire `buildContainer.ts`

**Why now:** With the type changes in place, this single file gets the full rewrite — drops the standby branch, the YAML-shaped input, the telegram opt-in, and derives market_data from the watches.

**Files:**
- Modify: `src/workers/buildContainer.ts`

- [ ] **Step 1: Replace the file**

Overwrite `src/workers/buildContainer.ts` with:

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
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
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

/**
 * Build a role-specific dependency container for a worker.
 *
 * Role matrix:
 * - `scheduler`     → all adapters (chart renderer, indicators, market data, price feeds, LLM, Temporal client)
 * - `analysis`      → no chart renderer, no indicators, no market data, no price feeds; needs LLM + notifier
 * - `notification`  → no chart, no indicators, no market data, no price feeds, no LLM, no Temporal client; only notifier + persistence
 */
export async function buildContainer(
  infra: InfraConfig,
  watches: WatchConfig[],
  role: WorkerRole,
): Promise<Container> {
  const pool = new pg.Pool({
    connectionString: infra.database.url,
    max: infra.database.pool_size,
    ssl: infra.database.ssl,
  });
  const db = drizzle(pool);

  const setupRepo = new PostgresSetupRepository(db, parseTimeframeToMs);
  const eventStore = new PostgresEventStore(db);
  const tickSnapshotStore = new PostgresTickSnapshotStore(db);
  const artifactStore = new FilesystemArtifactStore(db, infra.artifacts.base_dir);
  const llmUsageStore = new PostgresLLMUsageStore(db);
  const clock = new SystemClock();

  const usedSources = new Set(watches.filter((w) => w.enabled).map((w) => w.asset.source));

  const marketDataFetchers = new Map<string, MarketDataFetcher>();
  if (role === "scheduler") {
    if (usedSources.has("binance")) marketDataFetchers.set("binance", new BinanceFetcher());
    if (usedSources.has("yahoo")) marketDataFetchers.set("yahoo", new YahooFinanceFetcher());
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
      : buildProviderRegistry(infra, llmUsageStore);

  const consoleNotifier = new ConsoleNotifier();
  const notifier: Notifier =
    role === "notification" || role === "analysis"
      ? new MultiNotifier([
          consoleNotifier,
          new TelegramNotifier({ token: infra.notifications.telegram.bot_token }),
        ])
      : (null as unknown as Notifier);

  const priceFeeds = new Map<string, PriceFeed>();
  if (role === "scheduler") {
    priceFeeds.set("binance_ws", new BinanceWsPriceFeed());
    priceFeeds.set("yahoo_polling", new YahooPollingPriceFeed());
  }

  const watchesArr = [...watches];
  const watchById = (id: string) => watchesArr.find((w) => w.id === id);

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
    notifier,
    setupRepo,
    eventStore,
    artifactStore,
    tickSnapshotStore,
    clock,
    config: { watches: watchesArr },
    infra,
    watchById,
    temporalClient: temporalClient ?? (null as unknown as Client),
    db,
    pgPool: pool,
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

- [ ] **Step 2: Verify**

Run: `bun run lint`
Expected: errors will appear in the worker entry points (`scheduler-worker.ts`, `analysis-worker.ts`, `notification-worker.ts`) and `bootstrap-schedules.ts` — they still call `buildContainer` with the old signature `(infra, WatchesConfig | null, role)`. Tasks 6-9 fix them. No other failures expected.

- [ ] **Step 3: Commit**

```bash
git add src/workers/buildContainer.ts
git commit -m "refactor(workers): rewire buildContainer for DB watches and dropped standby"
```

---

## Task 6: Rewire `scheduler-worker.ts`

**Files:**
- Modify: `src/workers/scheduler-worker.ts`

- [ ] **Step 1: Replace the file**

Overwrite `src/workers/scheduler-worker.ts` with:

```ts
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildPriceMonitorActivities } from "@workflows/price-monitor/activities";
import { buildSchedulerActivities } from "@workflows/scheduler/activities";
import pg from "pg";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "scheduler-worker" });

const infra = loadInfraConfig();

const healthPort = Number(process.env.HEALTH_PORT ?? 8081);
const health = new HealthServer("scheduler-worker", healthPort);
health.start();

// Read watches from the only admin surface (Postgres `watch_configs`).
const bootstrapPool = new pg.Pool({
  connectionString: infra.database.url,
  max: 2,
  ssl: infra.database.ssl,
});
const watches = await loadWatchesFromDb(bootstrapPool);
await bootstrapPool.end();

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

log.info(
  { taskQueue: infra.temporal.task_queues.scheduler, watchCount: watches.length },
  "starting",
);

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

Key changes vs before:
- No `process.argv[2] ?? "config/watches.yaml"`.
- No `if (watches === null) { … standby … }`.
- A throwaway `bootstrapPool` reads watches once at boot, then closes. The container builds its own long-lived pool.
- Worker registers regardless of `watches.length` — Temporal will see a poller even with zero watches.

- [ ] **Step 2: Commit**

```bash
git add src/workers/scheduler-worker.ts
git commit -m "refactor(scheduler-worker): load watches from DB, drop standby branch"
```

---

## Task 7: Rewire `analysis-worker.ts`

**Files:**
- Modify: `src/workers/analysis-worker.ts`

- [ ] **Step 1: Replace the file**

Overwrite `src/workers/analysis-worker.ts` with:

```ts
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildSetupActivities } from "@workflows/setup/activities";
import pg from "pg";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "analysis-worker" });

const infra = loadInfraConfig();

const healthPort = Number(process.env.HEALTH_PORT ?? 8082);
const health = new HealthServer("analysis-worker", healthPort);
health.start();

const bootstrapPool = new pg.Pool({
  connectionString: infra.database.url,
  max: 2,
  ssl: infra.database.ssl,
});
const watches = await loadWatchesFromDb(bootstrapPool);
await bootstrapPool.end();

const container = await buildContainer(infra, watches, "analysis");
const connection = await NativeConnection.connect({ address: infra.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: infra.temporal.namespace,
  taskQueue: infra.temporal.task_queues.analysis,
  workflowsPath: require.resolve("../workflows/setup/setupWorkflow.ts"),
  activities: buildSetupActivities(container.deps),
});

log.info(
  { taskQueue: infra.temporal.task_queues.analysis, watchCount: watches.length },
  "starting",
);

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
git commit -m "refactor(analysis-worker): load watches from DB, drop standby branch"
```

---

## Task 8: Rewire `notification-worker.ts`

**Files:**
- Modify: `src/workers/notification-worker.ts`

- [ ] **Step 1: Replace the file**

Overwrite `src/workers/notification-worker.ts` with:

```ts
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildNotificationActivities } from "@workflows/notification/activities";
import pg from "pg";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "notification-worker" });

const infra = loadInfraConfig();

const healthPort = Number(process.env.HEALTH_PORT ?? 8083);
const health = new HealthServer("notification-worker", healthPort);
health.start();

const bootstrapPool = new pg.Pool({
  connectionString: infra.database.url,
  max: 2,
  ssl: infra.database.ssl,
});
const watches = await loadWatchesFromDb(bootstrapPool);
await bootstrapPool.end();

const container = await buildContainer(infra, watches, "notification");
const connection = await NativeConnection.connect({ address: infra.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: infra.temporal.namespace,
  taskQueue: infra.temporal.task_queues.notifications,
  activities: buildNotificationActivities(container.deps),
});

log.info(
  { taskQueue: infra.temporal.task_queues.notifications, watchCount: watches.length },
  "starting",
);

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
git commit -m "refactor(notification-worker): load watches from DB, drop standby branch"
```

---

## Task 9: Rewire `bootstrap-schedules.ts` CLI

**Files:**
- Modify: `src/cli/bootstrap-schedules.ts`

- [ ] **Step 1: Replace the file**

Overwrite `src/cli/bootstrap-schedules.ts` with:

```ts
import { bootstrapWatch } from "@config/bootstrapWatch";
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { getLogger } from "@observability/logger";
import { Client, Connection } from "@temporalio/client";
import pg from "pg";

const log = getLogger({ component: "bootstrap-schedules" });

const infra = loadInfraConfig();

const pool = new pg.Pool({
  connectionString: infra.database.url,
  max: 2,
  ssl: infra.database.ssl,
});

const watches = await loadWatchesFromDb(pool);
await pool.end();

const enabled = watches.filter((w) => w.enabled);

if (enabled.length === 0) {
  log.info("no enabled watches in DB — nothing to bootstrap");
  process.exit(0);
}

const connection = await Connection.connect({ address: infra.temporal.address });
const client = new Client({ connection, namespace: infra.temporal.namespace });

for (const watch of enabled) {
  await bootstrapWatch(watch, { client, taskQueues: infra.temporal.task_queues });
}

log.info({ count: enabled.length }, "done");
process.exit(0);
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/bootstrap-schedules.ts
git commit -m "refactor(bootstrap-schedules): load watches from DB instead of YAML"
```

---

## Task 10: Lint + test pass — confirm rewiring works

**Why now:** All callers of the YAML loader have been migrated. The codebase should compile cleanly. Old YAML files (`loadWatchesConfig.ts`, `seed-watches-from-yaml.ts`, `seedWatchesFromYaml.lib.ts`, `reload-config.ts`) still exist and still compile, but nothing in production code paths reaches them. Their tests still run and still pass.

- [ ] **Step 1: Lint**

Run: `bun run lint`
Expected: PASS. If any error remains, stop and investigate — it indicates a missed call site.

- [ ] **Step 2: Tests**

Run: `bun test`
Expected: ALL tests pass. The standby integration test (`test/integration/standby-boot.test.ts`) might either pass (if the new workers happen to satisfy its assertions) or fail (if it tested something specific to the old behavior). If it fails, that's expected — the test is going away in Task 14.

If non-standby-boot tests fail, stop and investigate.

---

## Task 11: Delete `loadWatchesConfig.ts` and its test

**Files:**
- Delete: `src/config/loadWatchesConfig.ts`
- Delete: `test/config/loadWatchesConfig.test.ts`

- [ ] **Step 1: Verify nothing still imports the file**

```bash
rtk proxy grep -rn "@config/loadWatchesConfig\|from.*loadWatchesConfig" /Users/arthur/Documents/Dev/projects/trading-flow/src /Users/arthur/Documents/Dev/projects/trading-flow/test --include='*.ts' | grep -v "loadWatchesConfig\.ts:" | grep -v "loadWatchesConfig\.test\.ts:"
```
Expected: empty. If non-empty, stop — fix the missing migration before deleting.

- [ ] **Step 2: Delete files**

```bash
rm /Users/arthur/Documents/Dev/projects/trading-flow/src/config/loadWatchesConfig.ts /Users/arthur/Documents/Dev/projects/trading-flow/test/config/loadWatchesConfig.test.ts
```

- [ ] **Step 3: Verify**

Run: `bun run lint && bun test test/config`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(config): delete loadWatchesConfig — replaced by loadWatchesFromDb"
```

---

## Task 12: Delete `reload-config` CLI

**Files:**
- Delete: `src/cli/reload-config.ts`

The applyReload primitive (`src/config/applyReload.ts`) remains and is invoked from tf-web's update path. The standalone CLI was YAML-bound and has no remaining caller.

- [ ] **Step 1: Verify nothing references the CLI script**

```bash
rtk proxy grep -rn "reload-config" /Users/arthur/Documents/Dev/projects/trading-flow --include='*.ts' --include='*.json' --include='*.yml' --include='*.yaml' --include='*.sh'
```
Expected: hits only inside docs (acceptable) and possibly a `package.json` script. If a script references it, remove that entry.

- [ ] **Step 2: Delete file**

```bash
rm /Users/arthur/Documents/Dev/projects/trading-flow/src/cli/reload-config.ts
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(cli): delete reload-config — applyReload is invoked from tf-web"
```

---

## Task 13: Delete `seed-watches-from-yaml` CLI + lib + test

**Files:**
- Delete: `src/cli/seed-watches-from-yaml.ts`
- Delete: `src/cli/seedWatchesFromYaml.lib.ts`
- Delete: `test/cli/seedWatchesFromYaml.test.ts`

The DB is now the source of truth. Seeding from YAML is a non-goal.

- [ ] **Step 1: Verify nothing imports the lib**

```bash
rtk proxy grep -rn "seedWatchesFromYaml\|seed-watches-from-yaml" /Users/arthur/Documents/Dev/projects/trading-flow --include='*.ts' --include='*.json'
```
Expected: hits only in the three files about to be deleted (and possibly docs).

- [ ] **Step 2: Delete files**

```bash
rm /Users/arthur/Documents/Dev/projects/trading-flow/src/cli/seed-watches-from-yaml.ts /Users/arthur/Documents/Dev/projects/trading-flow/src/cli/seedWatchesFromYaml.lib.ts /Users/arthur/Documents/Dev/projects/trading-flow/test/cli/seedWatchesFromYaml.test.ts
rmdir /Users/arthur/Documents/Dev/projects/trading-flow/test/cli 2>/dev/null || true
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(cli): delete seed-watches-from-yaml — DB is the source of truth"
```

---

## Task 14: Delete `standby-boot` integration test

**Files:**
- Delete: `test/integration/standby-boot.test.ts`

The "standby" concept is gone — workers always register. The test no longer maps to any code path.

- [ ] **Step 1: Delete the file**

```bash
rm /Users/arthur/Documents/Dev/projects/trading-flow/test/integration/standby-boot.test.ts
```

- [ ] **Step 2: Remove the package.json script**

If `package.json` has a `test:integration:standby` script, remove it. Run:

```bash
grep -n "standby" /Users/arthur/Documents/Dev/projects/trading-flow/package.json
```
Expected: 1 line — `"test:integration:standby": "RUN_INTEGRATION_STANDBY=1 bun test test/integration/standby-boot.test.ts"`. Delete that line.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(test): delete standby-boot integration test — concept removed"
```

---

## Task 15: Delete `config/watches.yaml.example` and the empty `config/` directory

**Files:**
- Delete: `config/watches.yaml.example`
- Delete: `config/` (only if empty)

- [ ] **Step 1: Confirm what's in `config/`**

```bash
ls -la /Users/arthur/Documents/Dev/projects/trading-flow/config/
```
Expected: only `watches.yaml.example`. If anything else is there, stop — investigate.

- [ ] **Step 2: Delete file and directory**

```bash
rm /Users/arthur/Documents/Dev/projects/trading-flow/config/watches.yaml.example
rmdir /Users/arthur/Documents/Dev/projects/trading-flow/config
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: delete config/watches.yaml.example and empty config dir"
```

---

## Task 16: Strip `WatchesConfigSchema` from the schema file

**Why last among code changes:** Now that no source file references `WatchesConfigSchema`, `LLMProviderConfigSchema`, or the `WatchesConfig` type, the schema can be cleanly trimmed.

**Files:**
- Modify: `src/domain/schemas/WatchesConfig.ts`
- Modify: `test/domain/schemas/WatchesConfig.test.ts`

- [ ] **Step 1: Update schema test first**

Open `test/domain/schemas/WatchesConfig.test.ts`. Identify and delete every test that exercises `WatchesConfigSchema` (the wrapper that validated `version`, `market_data`, `llm_providers`, `artifacts`, `watches`, the cross-cutting `superRefine`). Keep only tests that exercise `WatchSchema` (per-watch parsing) and `NotifyEventSchema`.

If unsure which tests to keep, after deleting tests run `bun test test/domain/schemas/WatchesConfig.test.ts` — every retained test must pass at the end of this task.

- [ ] **Step 2: Replace `WatchesConfig.ts`**

Overwrite `src/domain/schemas/WatchesConfig.ts` with:

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

export const NotifyEventSchema = z.enum([
  "confirmed",
  "rejected",
  "tp_hit",
  "sl_hit",
  "invalidated",
  "invalidated_after_confirmed",
  "expired",
]);
export type NotifyEvent = z.infer<typeof NotifyEventSchema>;

export const WatchSchema = z.object({
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

export type WatchConfig = z.infer<typeof WatchSchema>;
```

Removed vs before: `WatchesConfigSchema`, `LLMProviderConfigSchema`, the cross-cutting `superRefine` block, the `WatchesConfig` exported type.

- [ ] **Step 3: Run lint + schema tests**

Run: `bun run lint`
Expected: PASS.

Run: `bun test test/domain/schemas/WatchesConfig.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/domain/schemas/WatchesConfig.ts test/domain/schemas/WatchesConfig.test.ts
git commit -m "refactor(schemas): drop WatchesConfigSchema wrapper, keep WatchSchema only"
```

---

## Task 17: Adapt `loadWatchesFromDb.test.ts`

**Files:**
- Modify: `test/config/loadWatchesFromDb.test.ts`

- [ ] **Step 1: Strip the YAML-mixing tests**

Open `test/config/loadWatchesFromDb.test.ts`. Delete the entire `describe("loadWatchesConfig with DB-sourced watches", … )` block (lines 85-160) — those tests reference `loadWatchesConfig`, which no longer exists.

Keep the `describe("loadWatchesFromDb", …)` block (the first describe).

Also remove the now-unused imports at the top:
- `import { loadWatchesConfig } from "@config/loadWatchesConfig";`
- `import { mkdtempSync, writeFileSync } from "node:fs";`
- `import { tmpdir } from "node:os";`
- `import { join } from "node:path";`

- [ ] **Step 2: Run the test**

Run: `bun test test/config/loadWatchesFromDb.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add test/config/loadWatchesFromDb.test.ts
git commit -m "test(config): drop YAML-mixing branch from loadWatchesFromDb tests"
```

---

## Task 18: Strip `./config:/app/config:ro` mounts from docker-compose

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose-dev.yaml`

- [ ] **Step 1: Edit `docker-compose.yml`**

Remove every occurrence of `- ./config:/app/config:ro` in `docker-compose.yml`. Locations:
- the `worker_volumes` anchor (around line 124-128, inside the `bootstrap-schedules` service)
- the standalone `tf-web` volumes block (around line 234)

The anchor should end up like:
```yaml
volumes: &worker_volumes
  - ./prompts:/app/prompts:ro
  - artifacts_data:/data/artifacts
  - claude_workspace:/data/claude-workspace
```

The `tf-web` block:
```yaml
volumes:
  - ./prompts:/app/prompts:ro
  - artifacts_data:/data/artifacts:ro
```

- [ ] **Step 2: Edit `docker-compose-dev.yaml`**

In `docker-compose-dev.yaml`, the `tf-web` service re-states its volume list. Remove `- ./config:/app/config:ro` from that list. Result:

```yaml
volumes:
  - ./src:/app/src
  - ./tsconfig.json:/app/tsconfig.json:ro
  - ./bunfig.toml:/app/bunfig.toml:ro
  - ./components.json:/app/components.json:ro
  - ./prompts:/app/prompts:ro
  - artifacts_data:/data/artifacts:ro
  - ./package.json:/app/package.json
  - ./bun.lock:/app/bun.lock
  - tf_dev_node_modules:/app/node_modules
```

- [ ] **Step 3: Validate compose syntax**

Run:
```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose-dev.yaml config > /dev/null
```
Expected: exit 0 (no errors). Output is suppressed because we only care that parsing succeeds.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml docker-compose-dev.yaml
git commit -m "chore(compose): drop ./config bind mount — YAML loader removed"
```

---

## Task 19: Final verification — boot stack and confirm Temporal pollers

- [ ] **Step 1: Full lint + test pass**

Run: `bun run lint && bun test`
Expected: PASS.

- [ ] **Step 2: Stop the running stack and rebuild**

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose-dev.yaml down
docker compose --env-file .env -f docker-compose.yml -f docker-compose-dev.yaml up -d --build
```

- [ ] **Step 3: Wait for workers, check Temporal task queues**

```bash
docker exec tf-temporal temporal task-queue describe --task-queue scheduler --address localhost:7233
docker exec tf-temporal temporal task-queue describe --task-queue analysis --address localhost:7233
docker exec tf-temporal temporal task-queue describe --task-queue notifications --address localhost:7233
```
Expected for each: ≥1 entry under `Pollers:` (with `BuildID UNVERSIONED` and a recent `LastAccessTime`). The "No Workers Running" symptom is gone.

- [ ] **Step 4: Verify worker logs show watch count**

```bash
docker logs tf-scheduler-worker --tail 20
docker logs tf-analysis-worker --tail 20
docker logs tf-notification-worker --tail 20
```
Expected: each shows a `"starting"` log entry with `"watchCount":1`. No `"standby"` log lines.

- [ ] **Step 5: Verify backlogged scheduler workflows drain**

```bash
docker exec tf-temporal temporal task-queue describe --task-queue scheduler --address localhost:7233
```
Expected: `ApproximateBacklogCount` should drop to 0 (or close to 0) within ~1 minute. The 3 stale workflow tasks from before the refactor are picked up by the now-registered scheduler worker.

- [ ] **Step 6: End-to-end check via tf-web (optional but recommended)**

Open `http://localhost:8084` in a browser. Navigate to `/watches`. Edit the `btcusdt-1h` watch (e.g., toggle `include_chart_image`) and save. The `applyReload` flow should complete without error. Inspect `docker logs tf-scheduler-worker --tail 50` for a fresh log line indicating the reload signal was handled.

- [ ] **Step 7: Final commit (if any cleanup)**

If the verification revealed a small fix-up (a stray import, a typo), commit it. Otherwise the implementation is complete.

```bash
git status   # confirm clean
```

---

## Self-review notes (for the implementer)

- **Pool ownership in workers:** Each worker entry point creates a small throwaway pool just to read watches at boot, then closes it. The container then creates its own long-lived pool used by activities. This avoids a chicken-and-egg between "build container" and "load watches", at the cost of two transient connections at boot. Acceptable.
- **`reloadConfigFromDb` is full-replace:** It re-reads all watches and replaces `deps.config.watches` in place. This matches the previous YAML-load semantics. Per-watch incremental update (via the signal payload) is a possible future optimization, not in scope.
- **`watchesArr` array identity in `buildContainer`:** The container creates a fresh `watchesArr` and exposes it as `deps.config.watches`. The reload activity mutates this same array (`length = 0; push(...)`). The `watchById` closure captures `watchesArr`, so it sees the mutated state.
- **Temporal Schedule already exists:** The `tick-btcusdt-1h` schedule was created previously; bootstrap-schedules is idempotent (`bootstrapWatch` handles "already running" / `ScheduleNotFoundError` paths). No manual cleanup needed.
- **Retention values from YAML never had real consumers:** `keep_days` and `keep_for_active_setups` only existed in `WatchesConfigSchema`. The `purge-artifacts.ts` CLI takes an `--older-than-days=` flag and hardcodes the "keep_for_active_setups" semantics in its query (terminal-status filter). Deleting the schema entry is sufficient — no constants need to be added elsewhere.
- **`notifications.telegram` opt-in flag from YAML never gated anything important at runtime:** The bot token is required by `InfraConfig` regardless. The opt-in only chose `MultiNotifier` vs `ConsoleNotifier` alone. After the refactor, `MultiNotifier` is always wired for roles that emit notifications. Per-watch granularity remains via `notify_on: []`.
