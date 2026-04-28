# Standby Mode + Infra/Watches Config Split

**Date**: 2026-04-28
**Status**: Approved (pending implementation plan)

## Context

Currently, all four entry points (`bootstrap-schedules`, `scheduler-worker`, `analysis-worker`, `notification-worker`) crash on startup if `config/watches.yaml` is missing:

```
ENOENT: no such file or directory, open 'config/watches.yaml'
```

This is hostile to operators: spinning up the stack for the first time, or running CI smoke tests, requires a hand-crafted YAML before anything works. The user wants `docker compose up` to succeed even with no watches configured — the system simply enters **standby**.

A second, deeper issue surfaces during this work: `watches.yaml` today mixes two concerns that don't belong together. Infrastructure credentials and connection strings (`DATABASE_URL`, `TEMPORAL_ADDRESS`, `TELEGRAM_BOT_TOKEN`, etc.) live alongside user-defined trading watches, glued by `${ENV_VAR}` interpolation. This conflates *operator concerns* (where things live, secrets) with *user concerns* (what to watch, how to analyze).

This spec addresses both problems together: introduce a standby mode, and use the opportunity to split infra config (env-driven, always loaded) from watches config (yaml-driven, optional).

## Goals

1. `docker compose up` succeeds with **no `config/watches.yaml`** present. All workers stay alive in a "standby" state. `bootstrap-schedules` exits cleanly with code 0.
2. **Sharp separation** between infrastructure config (operator) and watches config (user). The user's YAML never contains credentials, connection strings, or filesystem paths.
3. **Fail fast on infra**: if a required env var (`DATABASE_URL`, `TEMPORAL_ADDRESS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) is missing, the worker crashes with a clear message. Standby covers "no watches", not "no infra".
4. **Fail fast on bad YAML**: if `watches.yaml` exists but is malformed or violates the schema, the worker crashes. Standby is "no intent expressed", not "intent mal-expressed".

## Non-goals

- **Hot reload of `watches.yaml`** (file watching). Out of scope. To exit standby: drop the file → `docker compose restart`.
- **Improvements to `reload-config.ts` functionality**. We port it to the new signatures; we do not add features.
- **Changes to workflow logic**. The Temporal workflows themselves are untouched.
- **Per-watch Telegram chat routing**. A single `TELEGRAM_CHAT_ID` env covers the whole deployment. Per-watch routing can be revisited later if a real use case appears.

## Architecture

### Two distinct config objects

```
                ┌────────────────────────────────┐
                │           process.env          │
                └──────────────────┬─────────────┘
                                   │
                                   ▼
                         loadInfraConfig()
                                   │
                                   ▼
                         ┌──────────────────┐
                         │   InfraConfig    │  always loaded; throws if required missing
                         └──────────────────┘

                ┌────────────────────────────────┐
                │      config/watches.yaml       │  optional file
                └──────────────────┬─────────────┘
                                   │
                                   ▼
                       loadWatchesConfig(path)
                                   │
                          ┌────────┴────────┐
                          ▼                 ▼
                    ENOENT → null    valid → WatchesConfig
                                          │
                                  invalid YAML / schema
                                          │
                                          ▼
                                       throws
```

`InfraConfig` is mandatory; `WatchesConfig` is optional. `null` means **standby**.

### `InfraConfig` shape

```ts
type InfraConfig = {
  database: {
    url: string;                    // DATABASE_URL                        (required)
    pool_size: number;              // DATABASE_POOL_SIZE                  (default 10)
    ssl: boolean;                   // DATABASE_SSL                        (default false)
  };
  temporal: {
    address: string;                // TEMPORAL_ADDRESS                    (required)
    namespace: string;              // TEMPORAL_NAMESPACE                  (default "default")
    task_queues: {
      scheduler: string;            // TEMPORAL_TASK_QUEUE_SCHEDULER       (default "scheduler")
      analysis: string;             // TEMPORAL_TASK_QUEUE_ANALYSIS        (default "analysis")
      notifications: string;        // TEMPORAL_TASK_QUEUE_NOTIFICATIONS   (default "notifications")
    };
  };
  notifications: {
    telegram: {
      bot_token: string;            // TELEGRAM_BOT_TOKEN                  (required)
      chat_id: string;              // TELEGRAM_CHAT_ID                    (required)
    };
  };
  llm: {
    openrouter_api_key: string | null;  // OPENROUTER_API_KEY              (optional)
  };
  artifacts: {
    base_dir: string;               // ARTIFACTS_BASE_DIR                  (default "/data/artifacts")
  };
  claude: {
    workspace_dir: string;          // CLAUDE_WORKSPACE_DIR                (default "/data/claude-workspace")
  };
};
```

`ANTHROPIC_API_KEY` is **not** in `InfraConfig` — it has no runtime consumer (only `test/llm/claudeSmoke.test.ts` reads it directly via `process.env`). It is removed from `docker-compose.yml`.

### `WatchesConfig` shape

```yaml
version: 1

# White-list of enabled market data sources. Base URLs are hardcoded in the adapters.
market_data: [binance]              # array of source names

# Notification channels. Console is always active; opt-in for others.
notifications:
  telegram: true                    # opt-in. Absent or false → console only

# LLM providers — credentials are NOT here (they're in the env).
llm_providers:
  claude_max:
    type: claude-agent-sdk
    daily_call_budget: 800
    fallback: openrouter
  openrouter:
    type: openrouter
    monthly_budget_usd: 50
    fallback: null

# Artifact retention policy (base_dir is in the env).
artifacts:
  retention: { keep_days: 30, keep_for_active_setups: true }

# User-defined trading watches.
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

### Diff vs current YAML

| Field | Before | After |
|---|---|---|
| `database.*` | YAML with `${ENV_VAR}` interpolation | `InfraConfig` (env only) |
| `temporal.*` | YAML with `${ENV_VAR}` interpolation | `InfraConfig` (env only) |
| `notifications.telegram.bot_token` | YAML with `${TELEGRAM_BOT_TOKEN}` | `InfraConfig` (env only) |
| `notifications.telegram.default_chat_id` | YAML with `${TELEGRAM_CHAT_ID}` | `InfraConfig` (env only, named `chat_id`) |
| `llm_providers.openrouter.api_key` | YAML with `${OPENROUTER_API_KEY}` | `InfraConfig` (env only) |
| `llm_providers.claude_max.workspace_dir` | YAML hardcoded path | `InfraConfig` (env only) |
| `artifacts.base_dir` | YAML hardcoded path | `InfraConfig` (env only) |
| `market_data: { binance: { base_url } }` | Object with adapter args | `[binance]` — array of enabled sources; base URL hardcoded in adapter |
| `notifications.telegram` (top-level block) | Object with creds | `boolean` — channel opt-in switch |
| `watches[].notifications.telegram_chat_id` | Per-watch override (always `${TELEGRAM_CHAT_ID}` in practice) | **Removed.** Single `TELEGRAM_CHAT_ID` env, deployment-wide |
| `watches[].notifications.notify_on` | Inside `notifications` block | Promoted to `watches[].notify_on` (top-level on the watch) |
| `expandEnvVars` (`${ENV_VAR}` substitution) | In loader | **Removed entirely** |

## Standby semantics

### Trigger

- `config/watches.yaml` does not exist (ENOENT) → standby.
- `config/watches.yaml` exists but is invalid YAML → **crash** with Bun's YAML error.
- `config/watches.yaml` is valid YAML but fails `WatchesConfigSchema` → **crash** with formatted Zod issues.
- A required env var is missing → **crash** before any standby check.

### Behavior per worker

| Worker | Standby behavior |
|---|---|
| `scheduler-worker` | Postgres pool + Temporal connection are **opened** (so health-check exposes infra status). `Worker.create` is **not called** (no task queue served — there's no work and we don't want to mask issues by polling for ghosts). HealthServer set to `"standby"` once at startup; the periodic `healthTick` (which today polls `worker.getState()`) is **not started** in standby. `await new Promise<void>((resolve) => process.once("SIGTERM", resolve))`. SIGTERM closes the Postgres pool + Temporal connection and stops the HealthServer cleanly. |
| `analysis-worker` | Same as scheduler. |
| `notification-worker` | Same as scheduler. |
| `bootstrap-schedules` | Logs `"standby: no watches.yaml — skipping schedule bootstrap"` and `process.exit(0)`. |

Rationale for not calling `Worker.create` in standby: a Temporal `Worker` continuously polls its task queue for work. Polling for tasks that will never come wastes connections and hides genuine standby state from monitoring. If standby ends, the operator restarts the container — `Worker.create` runs in the active path.

Rationale for opening the Postgres pool + Temporal connection in standby: it surfaces real infra problems immediately (Postgres unreachable, Temporal address wrong) instead of waiting until the user drops a `watches.yaml`. A "standby" container that crashes because Postgres isn't there is the right signal — the operator should fix the deployment before adding watches.

### HealthServer

`Status` enum gains `"standby"`:

```ts
type Status = "ok" | "degraded" | "down" | "standby";
```

Standby payload (HTTP 200):

```json
{
  "service": "scheduler-worker",
  "status": "standby",
  "reason": "no watches.yaml — system idle, drop the file and restart",
  "infra": { "postgres": "ok", "temporal": "ok" }
}
```

HTTP 200 because the worker is alive and the infra it depends on is reachable. The `"standby"` is in the payload, not the status code, so monitoring can treat it distinctly from `"ok"`.

## Component refactor

### New files

- `src/config/InfraConfig.ts`
  - Exports `InfraConfigSchema` (Zod) and `loadInfraConfig(): InfraConfig`.
  - Reads `process.env`, applies defaults, throws `MissingInfraEnvError` if any required var is unset or empty.
- `src/config/loadWatchesConfig.ts`
  - Exports `loadWatchesConfig(path: string): Promise<WatchesConfig | null>`.
  - Returns `null` on `ENOENT`; throws on malformed YAML or schema violation.
- `src/adapters/notify/ConsoleNotifier.ts`
  - Implements the `Notifier` port. Each notification is logged via the project logger with structured fields. Always available, no config.
- `src/adapters/notify/MultiNotifier.ts`
  - Fan-out adapter. Constructor takes `Notifier[]`. Forwards each call to all delegates.

### Deleted files

- `src/config/loadConfig.ts` — replaced by `InfraConfig.ts` + `loadWatchesConfig.ts`. The `expandEnvVars` helper goes with it.

### Modified files

**`src/domain/schemas/Config.ts`**
- Rename type `Config` → `WatchesConfig`. Schema renamed to `WatchesConfigSchema`.
- Drop `database`, `temporal` blocks entirely.
- `notifications`: replace nested telegram object with `{ telegram: z.boolean().default(false) }.prefault({})`.
- `market_data`: change from `z.record(z.string(), z.unknown())` to `z.array(z.string())`.
- `llm_providers.openrouter`: drop `api_key` field. `llm_providers.claude_max`: drop `workspace_dir` field.
- `artifacts`: drop `base_dir` field. Keep `type` and `retention`.
- `WatchSchema`: drop `notifications.telegram_chat_id`. Hoist `notifications.notify_on` to `watches[].notify_on`. Remove other fields under `notifications` (none remain).
- `superRefine`: keep provider name validation; switch `market_data[watch.asset.source]` check to `market_data.includes(watch.asset.source)`.

**`src/workers/buildContainer.ts`**
- New signature: `buildContainer(infra: InfraConfig, watches: WatchesConfig | null, role: WorkerRole): Promise<Container>`.
- Postgres pool, Temporal client, persistence stores, clock are always built (use `infra` for connection params).
- When `watches === null`:
  - `marketDataFetchers = new Map()`, `chartRenderer = null`, `indicatorCalculator = null`, `priceFeeds = new Map()`, `llmProviders = new Map()`.
  - `notifier = null` (no events to notify in standby).
  - The existing `null as unknown as T` cast pattern in `ActivityDeps` is preserved: the runtime invariant is that no activity ever runs in standby (because no `Worker.create`), so these casts are safe.
- When `watches !== null`:
  - Market data fetchers built per `watches.market_data` array, looking up adapter by name.
  - Provider registry built via `buildProviderRegistry(watches, infra, llmUsageStore)`.
  - Notifier composed: console always; telegram appended via `MultiNotifier` if `watches.notifications.telegram === true`. If only console, `notifier = new ConsoleNotifier()`. If both, `notifier = new MultiNotifier([console, telegram])`.

**`src/adapters/llm/buildProviderRegistry.ts`**
- Signature: `(watches: WatchesConfig, infra: InfraConfig, store: LLMUsageStore)`.
- Reads `infra.llm.openrouter_api_key` for `openrouter` providers and `infra.claude.workspace_dir` for `claude-agent-sdk` providers.

**`src/adapters/market-data/BinanceFetcher.ts` and `YahooFinanceFetcher.ts`**
- Constructor takes no required args (the base URL is a `const` at the top of the file).

**`src/adapters/notify/TelegramNotifier.ts`**
- Constructor: `{ token: string, chatId: string }`. Drop any `default_chat_id` field. The notifier always sends to the single deployment chat.

**`src/observability/healthServer.ts`**
- `Status` adds `"standby"`. Payload supports an optional `reason: string` field. `setStatus(status, meta)` accepts `meta.reason`.

**Entry points** — common pattern across all four (`src/cli/bootstrap-schedules.ts`, `src/cli/reload-config.ts`, `src/workers/scheduler-worker.ts`, `src/workers/analysis-worker.ts`, `src/workers/notification-worker.ts`):

```ts
const infra = loadInfraConfig();                                     // throws if env missing
const watches = await loadWatchesConfig(configPath);                  // null if file missing

if (watches === null) {
  // standby
  // workers: start HealthServer with "standby", then await SIGTERM
  // bootstrap-schedules: log + process.exit(0)
  // reload-config: log "nothing to reload" + process.exit(0)
  return;
}

// active path — build container, register Temporal worker, run
```

**`docker-compose.yml`**
- Postgres healthcheck: `pg_isready -h postgres -U $${POSTGRES_USER}` — TCP via service name forces network attachment validation, killing the OrbStack race that motivated this work.
- Drop `ANTHROPIC_API_KEY` from the worker env block (no consumer).
- Add the new optional env vars with sensible defaults (so existing `.env` files keep working).

**`.env.example`** — refreshed with all new vars and inline comments explaining defaults.

**`config/watches.yaml.example`** — rewritten with the new shape (no `${...}` interpolation, no infra fields).

## Test plan

- `src/config/InfraConfig.test.ts`
  - Required env missing → throws with the var name in the message.
  - All required env present, optional ones absent → defaults applied, types correct.
  - `DATABASE_POOL_SIZE`/`DATABASE_SSL`/etc. parsed from strings to numbers/booleans.
- `src/config/loadWatchesConfig.test.ts`
  - File missing → returns `null`.
  - File present but malformed YAML → throws.
  - File present, valid YAML, schema violation → throws with formatted Zod issues.
  - File present and valid → returns `WatchesConfig` matching the schema.
- Existing `loadConfig` tests are deleted (the function no longer exists).
- Smoke integration test: `docker compose up` with no `config/watches.yaml` → all containers healthy within 60s, `/health` returns `"standby"` for the three workers, `bootstrap-schedules` exits 0.

## Migration impact

- Anyone with an existing `watches.yaml` must drop the `database`, `temporal`, top-level `notifications`, `llm_providers.*.api_key`, `llm_providers.claude_max.workspace_dir`, `artifacts.base_dir`, and per-watch `notifications.telegram_chat_id` fields, and change `market_data` from object to array. The `.env.example` documents the new env layout.
- Sample `watches.yaml.example` is updated, so a fresh `cp watches.yaml.example watches.yaml` works out of the box (assuming the env is set).
