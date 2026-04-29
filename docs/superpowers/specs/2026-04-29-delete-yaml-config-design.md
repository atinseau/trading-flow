# Delete YAML config — DB as the only admin surface

**Date:** 2026-04-29
**Status:** Design approved, awaiting implementation plan
**Supersedes:** `2026-04-28-standby-mode-config-split-design.md` (the half-finished DB-watches refactor that this spec completes)

## Problem

Workers report healthy but Temporal sees no pollers. Symptom: `tick-btcusdt-1h`
schedule fires every hour, workflow tasks accumulate in the `scheduler` queue,
no worker consumes them.

Root cause: every worker boots through `loadWatchesConfig("config/watches.yaml")`.
The YAML file does not exist on disk (only `watches.yaml.example` is committed).
The loader returns `null`, the workers enter a "standby" branch that starts a
health server but **never registers a Temporal Worker**. Containers look healthy
because health endpoints respond — but no Temporal poll happens.

A previous refactor (`2026-04-28-standby-mode-config-split-design.md`) introduced
`loadWatchesFromDb` so watches[] could come from Postgres. That refactor was
never wired up: no caller passes `{ pool }` to `loadWatchesConfig`, so even if
the YAML existed, watches would still come from YAML rather than DB. The DB
table `watch_configs` holds one watch (`btcusdt-1h`) that's effectively orphaned
from the runtime.

## Goal

Delete the YAML config entirely. Make `watch_configs` (DB) the single admin
surface. No new DB tables, no new env vars, no new abstractions. Pure deletion
plus a small re-wire.

## Non-goals

- No DB schema change. `watch_configs` and `watch_config_revisions` stay as-is.
- No new env vars. `InfraConfig.ts` is unchanged.
- No new "catalog" abstraction layer. Constants live in the file that consumes
  them.
- No hot-reload mechanism beyond what already exists (`applyReload` signal +
  workflow activity).
- No tf-web admin UI changes for the migration itself. The wizard already only
  edits per-watch config, which is exactly what's left after the YAML is gone.

## Mental model after the refactor

What was in the YAML splits into three categories:

| YAML section | Becomes |
|---|---|
| `version: 1` | Deleted (useless metadata). |
| `market_data: [binance]` | Derived at runtime from `watches[*].asset.source`. The fetcher set is built from the union of sources used by enabled watches. |
| `notifications.telegram: bool` | Deleted. The boolean opt-in becomes implicit: if `TELEGRAM_BOT_TOKEN` is in env (already required by `InfraConfig`), Telegram is wired in `MultiNotifier`. Per-watch opt-out happens via `notify_on: []` (already supported). |
| `llm_providers: { claude_max, openrouter }` | Hardcoded constant inside `buildProviderRegistry.ts`. The tf-web wizard already hardcodes the provider list in `section-analyzers.tsx:13-24`; runtime now matches. |
| `artifacts: { type, retention }` | Hardcoded constants inside the consumers (`FilesystemArtifactStore` is the only `type`; retention values become a const used by the purge CLI). |
| `watches: [...]` | Read from `watch_configs` (DB) via `loadWatchesFromDb`. |

The single admin surface is `watch_configs`. Everything else is either env-driven
infra (`InfraConfig`) or a code constant.

## Architecture

### Before (broken)

```
config/watches.yaml ──▶ loadWatchesConfig() ──▶ workers
                                                bootstrap-schedules CLI
                                                reload-config CLI
                                                reloadConfigFromDisk activity

env vars            ──▶ loadInfraConfig()  ──▶ workers (creds, addresses, ports)
```

### After

```
watch_configs (DB) ──▶ loadWatchesFromDb()  ──▶ workers, bootstrap-schedules CLI

env vars            ──▶ loadInfraConfig()    ──▶ workers (unchanged)

Code constants      ──▶ buildProviderRegistry, FilesystemArtifactStore, purge CLI

Reload runtime path:
  tf-web (UI save) ──▶ applyReload() ──signal──▶ schedulerWorkflow
                                                       │
                                                       ▼
                                       activity reloadConfigFromDb (re-reads watch_configs)
```

## Detailed changes

### Files deleted

- `src/config/loadWatchesConfig.ts`
- `src/cli/seed-watches-from-yaml.ts`
- `src/cli/seedWatchesFromYaml.lib.ts`
- `src/cli/reload-config.ts`
- `config/watches.yaml.example`
- `config/` directory (if no other content)
- `test/config/loadWatchesConfig.test.ts`
- `test/cli/seedWatchesFromYaml.test.ts`
- `test/integration/standby-boot.test.ts`

### Files modified

**`src/config/loadWatchesFromDb.ts`** — becomes the only watches loader. Same
signature: `(pool) => Promise<WatchConfig[]>`. No wrapper config (no
`WatchesConfig` return type — just an array of `WatchConfig`).

**`src/workers/scheduler-worker.ts`**, **`analysis-worker.ts`**,
**`notification-worker.ts`** — for each:
- Remove `process.argv[2] ?? "config/watches.yaml"` arg parsing.
- Remove the `if (watches === null) { … standby … }` branch (~14 lines).
- Replace `await loadWatchesConfig(configPath)` with
  `await loadWatchesFromDb(pool)`. The pool is built upstream (workers already
  build a pg.Pool inside `buildContainer`, just hoist it).
- If DB returns 0 watches, the worker still registers with Temporal. It just
  has nothing to do — Temporal sees a poller but no work. This matches
  Temporal-native expectations and removes the "no pollers" symptom even when
  no watches are configured.

**`src/workers/buildContainer.ts`** — signature changes to take
`watches: WatchConfig[]` (drop the `null` case, drop the `WatchesConfig` wrapper).
- `marketDataFetchers` set: instead of gating on `watches.market_data.includes("binance")`,
  derive from `new Set(watches.map(w => w.asset.source))`.
- Notifier wiring: drop the `if (watches.notifications.telegram)` branch. Always
  wire `MultiNotifier([console, telegram])` because `TELEGRAM_BOT_TOKEN` is
  already required by `InfraConfig` (boot fails early if absent).
- Remove the standby branch (lines 74-101).

**`src/cli/bootstrap-schedules.ts`** — replace `loadWatchesConfig` call with
`loadWatchesFromDb(pool)`. Iterate the array, filter `enabled === true`, call
`bootstrapWatch` per row. Drop standby branch.

**`src/workflows/scheduler/activities.ts`** — rename activity
`reloadConfigFromDisk` → `reloadConfigFromDb`. Body: read the single watch by id
from `watch_configs` instead of re-reading the YAML. Mutate `deps.config` in
place as it does today (the workflow signal handler already calls this).

**`src/adapters/llm/buildProviderRegistry.ts`** — instead of iterating
`watches.llm_providers`, iterate a hardcoded constant:

```ts
const PROVIDER_DEFAULTS = {
  claude_max:  { type: "claude-agent-sdk", daily_call_budget: 800, fallback: "openrouter" as string | null },
  openrouter:  { type: "openrouter",       monthly_budget_usd: 50, fallback: null as string | null },
} as const;
```

Cycle validation in this graph stays inside `buildProviderRegistry`.

**`src/cli/purge-artifacts.ts`** (or wherever retention is consumed) —
hardcode `keep_days: 30`, `keep_for_active_setups: true` as local constants.

**`src/domain/schemas/WatchesConfig.ts`**:
- Delete `WatchesConfigSchema` and the `superRefine` block (the cross-cutting
  invariants are now: provider name validation moves into
  `buildProviderRegistry` because the catalog is local; market_data validation
  disappears because we derive instead of whitelist).
- Delete `LLMProviderConfigSchema` (no longer parsed from external input).
- Keep `WatchSchema`, `NotifyEventSchema`, `WatchConfig`, `NotifyEvent`. These
  are the API surface used by tf-web and the DB JSONB validator.
- Delete the exported `WatchesConfig` type.

**`docker-compose.yml`** — for each of `bootstrap-schedules`,
`scheduler-worker`, `analysis-worker`, `notification-worker`, `tf-web`:
- Remove the `./config:/app/config:ro` volume mount.

**`docker-compose-dev.yaml`** — same: remove `./config:/app/config:ro` from
`tf-web` volumes.

**`src/client/server.ts`** + **`src/client/lib/watchConfigService.ts`** —
inspect for any residual YAML coupling. The hooks (`bootstrap`, `applyReload`,
`tearDown`) already work on a `WatchConfig`, so the lifecycle path is
unaffected. Confirm nothing reads `config/watches.yaml`.

### Files unchanged

- `src/adapters/persistence/schema.ts` — DB stays as-is.
- `src/config/InfraConfig.ts` — env-driven infra config unchanged.
- `src/config/bootstrapWatch.ts`, `tearDownWatch.ts`, `watchOps.ts` — primitives
  that operate on `WatchConfig`, agnostic to source.
- `src/config/applyReload.ts` — same; still sends the `reloadConfig` signal,
  the activity it triggers is renamed but the orchestration is identical.
- All other CLIs (`force-tick`, `kill-setup`, `pause-watch`, `cost-report`,
  `replay-setup`, `show-setup`, `list-setups`, `migrate`).
- `src/domain/schemas/WatchesConfig.ts` exports of `WatchSchema`,
  `NotifyEventSchema`, `WatchConfig`, `NotifyEvent`.
- tf-web wizard (`watch-form/`) and the watches API
  (`src/client/api/watches.ts`).

## Validation strategy

Before, `WatchesConfigSchema.superRefine` enforced three invariants at YAML
parse time. After:

| Invariant | New enforcement point |
|---|---|
| `watch.asset.source` is a known source | Runtime: `marketDataFetchers.get(source)` returns a fetcher only for sources we have adapters for. If a watch declares an unknown source, the fetcher map is empty for that watch and the activity that uses it logs and skips. (Current code already tolerates missing fetchers.) |
| `watch.analyzers.*.provider` is a known provider | Worker boot: `buildProviderRegistry` builds the registry from `PROVIDER_DEFAULTS`. When an activity resolves an analyzer's provider through the registry and finds nothing, it raises an error visible in Temporal — same failure surface as before, just at runtime instead of YAML-parse time. The tf-web wizard already constrains the dropdown to `["claude_max", "openrouter"]`, so the only path to an unknown provider is a hand-edited DB row. |
| No cycle in provider fallback graph | Inside `buildProviderRegistry`. The constant is small and validated once at boot. |

Per-watch DB writes (tf-web POST/PATCH `/api/watches`) are validated by
`WatchSchema.parse` — unchanged. Cross-cutting invariants are no longer
enforced at write time because the catalog is fixed in code; the only
write-time concern is "does this watch parse?", which it does.

## Migration / rollout

The current state is already broken (workers in standby). Rolling out this spec
replaces the broken state with a working one. Steps:

1. Implement the code changes above.
2. Verify `watch_configs` already contains the watches the user expects. If
   the DB is empty in some environment, the user inserts rows via tf-web (or
   re-applies a SQL dump). No automatic seed from YAML.
3. Restart the docker stack. Workers boot, register with Temporal, and start
   polling.
4. The pre-existing Temporal Schedule (`tick-btcusdt-1h`) keeps firing. The
   3 backlogged workflow tasks in the `scheduler` queue are picked up by the
   newly-registered scheduler worker (ordinary workflow execution; nothing
   special needed).

Rollback: revert the commit. The YAML loader returns to being authoritative.
Existing DB rows in `watch_configs` continue to exist (untouched by this
refactor) and would simply be ignored again, as they are today.

## Out of scope (deliberate)

- Adding tf-web UI for editing the provider catalog. If you want to change a
  budget or add a provider, edit `buildProviderRegistry.ts` and redeploy.
- Adding tf-web UI for editing artifacts retention. Same — code change.
- Replacing `applyReload` orchestration with a different reload mechanism
  (Postgres LISTEN/NOTIFY, polling, etc.). The current signal-based path works
  for the watch-update flow we have.
- Multi-tenant or multi-environment config. This is a single-user, single-env
  system; constants in code are appropriate.

## Acceptance criteria

- `find . -path ./node_modules -prune -o -name 'watches.yaml*' -print` returns
  nothing inside the project (modulo the `.worktrees` working trees, which are
  separate).
- `grep -r 'loadWatchesConfig\|seedWatchesFromYaml\|reload-config\|standby' src test` returns empty.
- `docker compose up -d` starts the stack; `temporal task-queue describe --task-queue scheduler` shows ≥1 poller per task queue.
- Editing a watch via tf-web (`PUT /api/watches/:id`) successfully signals
  the workflow and updates the Temporal Schedule cron when applicable
  (existing behavior, verified end-to-end).
- `bun test` passes; deleted tests do not leave orphan imports.
