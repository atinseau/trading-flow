# trading-flow — Claude operating notes

Multi-asset trading bot. 3-stage LLM pipeline (Detector → Reviewer → Finalizer)
orchestrated by Temporal, event-sourced in Postgres, Telegram for human-in-the-
loop. Bun + TypeScript strict + Drizzle + Biome.

For the **why / what** of the system: `README.md` and `docs/superpowers/specs/`.
This file is the **how-to-not-break-it** for an AI assistant.

---

## Architectural rules (enforced by Biome — `biome.json`)

- `src/domain/**` is **pure**. No imports of `adapters/`, `workflows/`,
  `drizzle-orm`, `@temporalio/*`, `@anthropic-ai/*`. Domain talks to the world
  via ports (`src/domain/ports/`).
- `src/workflows/**` (except `activities.ts`) cannot import `src/adapters/**`.
  Workflows orchestrate; activities are the only place adapters touch I/O.
- Path aliases: `@domain/*`, `@adapters/*`, `@workflows/*`, `@config/*`,
  `@observability/*`, `@cli/*`, `@client/*`, `@shared/*`, `@test-fakes/*`,
  `@test-helpers/*` (see `tsconfig.json`). Workflow bundles need the
  `TsconfigPathsPlugin` (`src/workers/workflowBundlerOptions.ts`) — re-use it
  for any new worker.

## Temporal gotchas (all have bitten the codebase at least once)

### 1. `Date` payloads cross activity boundaries as ISO strings

Temporal's default payload converter serializes `Date` to a string and does NOT
revive it. TypeScript types lie. **Always coerce at the workflow / store
boundary** — `new Date(x)` accepts both shapes. Reference impls:

- `coerceSessionWindow` — `src/workflows/replay/replaySessionWorkflow.ts`
- Store-side coerce — `src/adapters/persistence/PostgresReplayEventStore.ts`

### 2. Mutate workflow state BEFORE `await persistEvent` in signal handlers

Signal handlers run cooperatively. While one handler is `await`ing, the next
queued invocation of the same (or another) handler runs. If you flip the status
*after* the await, both handlers pass the `isActive` guard and double-emit
events (observed in production: 1516 duplicate `PriceInvalidated` events on a
single setup in one hour).

Reference impls : `priceCheckSignal` and `corroborateSignal` handlers in
`src/workflows/setup/setupWorkflow.ts` — both flip `state.status` BEFORE the
persist await, with comments explaining the race.

### 3. Workflow code must be deterministic

Workflow bundles are webpack-built and run in a V8 isolate. No `Date.now()`
(use `workflowInfo()` or pass through an activity), no `Math.random()` outside
`@temporalio/workflow`'s `uuid4`, no `Bun.*` APIs, no Node I/O. Side effects
belong in activities.

### 4. Workflow signal payloads can be batched

The `replayTick` signal accepts both `tickAt?: string` (single) and
`tickAts?: string[]` (batch up to 50). When designing a new signal, prefer
batching from day 1 — a Step-5 UI button that fires 5 separate signals will
hammer the worker on the round-trip.

## The "extract → unit-test → consume in workflow" pattern

When workflow decision logic is non-trivial, extract it into a sibling pure
function and unit-test the truth table. This is how dead-config bugs are
prevented — see the docblock at `src/workflows/scheduler/reviewerGating.ts:1`
for the cautionary tale (the `reviewer_skip_when_detector_corroborated` flag
was silently ignored in production for 7 days because the decision was
inlined in the workflow with no test).

Examples in the repo :

- `src/workflows/scheduler/reviewerGating.ts` (boolean decision)
  + `test/workflows/scheduler/reviewerGating.test.ts` — truth-table
- `src/workflows/replay/replaySessionWorkflow.ts::coerceSessionWindow`
  + `test/workflows/replay/coerceSessionWindow.test.ts`
- `src/workflows/replay/processTick.ts` (orchestration extracted from the
  workflow body so a 21KB tick can be tested without TestWorkflowEnvironment)
- `src/workflows/scheduler/preFilter.ts`, `src/workflows/scheduler/dedup.ts`
- `src/client/components/replay/derivePlayheadAt.ts`,
  `src/client/components/replay/replayStepGating.ts` (UI-state helpers
  extracted for unit test)

## Pipeline coherence (live ↔ replay)

The live pipeline (`setupWorkflow.ts` + `schedulerWorkflow.ts`) and the
replay pipeline (`processTick.ts`) MUST stay logically equivalent on the
same input. Strategy 3 (controlled duplication, see
`docs/superpowers/specs/2026-05-08-replay-mode-design.md`) accepts some
infrastructure duplication for clear isolation, but **decisions that
drive scoring or state transitions are shared helpers**, not duplicated
logic.

The shared decisions live in `src/domain/pipeline/`:

- `applyCorroboration` — detector signed corroboration → Strengthened /
  Weakened event with the correct `source` discriminant
  (`detector_corroboration` / `detector_decorroboration`). Score clamp
  `[0, scoreMax]` + finalizer/dead threshold transitions.
- `applyPriceCheck` — REVIEWING / FINALIZING price breach → strict
  inequality (LONG `<`, SHORT `>`) → `PriceInvalidated` via the canonical
  builder. TRACKING is a separate channel.
- `buildPriceInvalidationEvent` — canonical event builder used in both
  REVIEWING (`trigger: "price_monitor"`) and TRACKING (`trigger:
  "tracker"`) breach branches, with the appropriate Telegram preview.
- `computeTtlExpiresAt` — `fromTickAt + ttl_candles × timeframe`. Used
  by both pipelines. The pre-fix live bug was hardcoding `× 3600_000`
  for hours instead of multiplying by the actual timeframe minutes.
- `shouldRunFeedback` — combined `watch.feedback.enabled` gate +
  replay session feedback mode + outcome eligibility.
- `timeframeToMinutes` / `timeframeToMs` — single source of truth for
  candle duration math.

When adding a new pipeline feature : if it makes a scoring or state
decision, extract it into `src/domain/pipeline/` first and consume from
both pipelines. The cross-pipeline harness (`bun run test:parity`)
catches drift if you forget. **Imports** : both `@domain/*` aliases and
sibling-relative paths work for value imports in workflow-bundled
files — `replaySessionWorkflow.ts`, `schedulerWorkflow.ts`, and
`processTick.ts` all use `@domain/*` for runtime imports in production.
`setupWorkflow.ts` and `trackingLoop.ts` happen to use relative paths
exclusively, which is a per-file stylistic choice (not a webpack
constraint). Pick the convention of the file you're editing.

See `docs/superpowers/specs/2026-05-14-pipeline-coherence-design.md`
for the rationale + the original drift audit (11 drifts, 5 parity
scenarios + 7 helper extractions).

## Replay subsystem — strict isolation contract

Spec: `docs/superpowers/specs/2026-05-08-replay-mode-design.md` §10 lists 10
invariants. They are not negotiable — violating them means live trades can be
silently corrupted by a replay session.

- Replay code (`src/workflows/replay/**`, `src/adapters/persistence/PostgresReplay*`)
  **MUST NOT** write to live tables: `setups`, `events`, `tick_snapshots`,
  `llm_calls`, `lessons`, `lesson_events`, `watch_states`, `watch_configs`,
  `watch_config_revisions`, `artifacts`.
- Replay-owned tables: `replay_sessions`, `replay_events`, `replay_llm_calls`.
  Plus the **shared** `llm_response_cache` (read + write — that's why a second
  replay run is free).
- No live Telegram from replay: use `domain/notify/formatTelegramText.ts`
  formatters and attach to `data.telegramPreview` on the persisted replay
  event.
- Replay workflow starts no child workflows, no Temporal Schedules, no timers.
  Only signals (`replayTick`, `pause`, `resume`, `terminate`) drive it.
- The single deliberate live write is `POST /api/replay/sessions/:id/events/:eventId/promote`
  which materializes a `FeedbackLessonProposed` replay event into the live
  `lessons` table — explicit, idempotent (`inputHash = "replay-promote:{eventId}"`).

When in doubt, read the replay activity (`src/workflows/replay/activities.ts`)
side-by-side with the live equivalent. The replay path is **controlled
duplication** of live — diverging behavior is a bug. The spec preamble (lines
9-43) documents where reality diverged from the original Strategy-1 spec.

## Prompt versioning + LLM response cache

- Prompts: `prompts/<role>.md.hbs` (user template, Handlebars) +
  `prompts/<role>.system.md`.
- Versions tracked in-file as a Handlebars comment header:
  `{{!-- version: <role>_v<N> --}}`. Current : `detector_v6`, `reviewer_v6`,
  `finalizer_v4`, `feedback_v1`.
- `computeInputHash` (`src/domain/services/inputHash.ts`) keys the response
  cache on `promptVersion`, `ohlcvSnapshot`, `chartUri`, `indicators`,
  `indicatorParams` (defaults stripped), `activeLessonIds` (sorted).
- **Bumping a prompt version invalidates the cache.** Bump on behavior changes
  (rewording an instruction, adding/removing a section, schema changes). Do
  NOT bump on cosmetic whitespace edits — you'll burn LLM budget re-filling
  the cache on replay.

## Tests

Same shape as `package.json` scripts. Five levels :

| Scope | Command | Notes |
|---|---|---|
| Domain | `bun test test/domain` | Pure, fast. No external deps. |
| Adapters | `bun test test/adapters` | Uses testcontainers Postgres for DB-backed adapters. |
| Workflows | `bun test test/workflows` | `@temporalio/testing` `TestWorkflowEnvironment` (downloads Temporal CLI on first run). |
| Parity | `bun run test:parity` | Cross-pipeline regression : same scenarios run against live (`setupWorkflow`) and replay (`processTick`), captured event chains diffed via `compareCanonical`. 5 scenarios, ~5s. |
| E2E | `RUN_E2E=1 bun test test/e2e/...` | Requires `bun run compose:dev` stack up. 4 suites : `full-pipeline`, `feedback-loop`, `replay-pipeline`, `web-smoke`. |
| LLM smoke | `RUN_LLM_CLAUDE=1` / `RUN_LLM_OPENROUTER=1` | Costs real money. Live API call. |
| Telegram | `RUN_LIVE_TELEGRAM=1` | Hits the real bot. |

Test-side aliases : `@test-fakes/*` → `test/fakes/*`, `@test-helpers/*` →
`test/helpers/*`.

## Dev commands you'll actually need

```sh
bun run compose:dev    # Full stack with dev overrides + Claude OAuth bootstrap
bun run compose:sync   # Restart tf-web only (e.g. after env edits)
bun run compose:nuke   # down -v (wipes Postgres + Temporal state)
bun run logs:workers   # Tail scheduler + analysis + notification

bun run db:generate    # Drizzle migration from schema diff
bun run db:migrate     # Apply pending migrations

# Direct DB (port only exposed by compose:dev overlay)
PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U trading_flow -d trading_flow

# Force a tick manually
bun run src/cli/force-tick.ts <watchId>

# Setup admin
bun run src/cli/{list,show,kill}-setup.ts ...

# Lessons admin (same as Telegram inline buttons / web UI buttons)
bun run src/cli/{list,show,approve,reject,pin,unpin,archive}-lesson.ts ...

# Cost report
bun run src/cli/cost-report.ts
```

**Hot-reload asymmetry** : `tf-web` bind-mounts `./src` + `bun --watch` →
instant. Workers run from a baked image — a code change needs
`compose:dev` rebuild (or `docker compose up -d --build <worker>`).

## Where things live (quick map)

- **Schema** (14 tables, drizzle) : `src/adapters/persistence/schema.ts`
- **Migrations** : `migrations/*.sql` (16 files, generated by drizzle).
- **Infra config** : `src/config/InfraConfig.ts` (Zod-validated env, single
  entry point. 4 task queues : scheduler, analysis, notifications, replay).
- **Workflows** : `src/workflows/{setup,scheduler,replay,feedback,price-monitor,marketClock,notification}/`
- **Activities** : `src/workflows/<domain>/activities.ts` (only place adapters
  touch I/O).
- **Workers** : `src/workers/*-worker.ts` — note that `analysis-worker.ts`
  hosts BOTH analysis + replay queues in one process (two `Worker.create()`
  on a shared connection).
- **Frontend** : `src/client/` (React 19 + React-Router + Radix + Tailwind 4,
  served by `src/client/server.ts` via `Bun.serve`. 16 routes in
  `src/client/frontend.tsx`).
- **Prompts** : `prompts/*.md.hbs` + `prompts/*.system.md` (versioned).
- **Operational CLI** : `src/cli/*.ts` (20 scripts).

## `docs/superpowers/` is epoch-frozen

`docs/superpowers/specs/` and `docs/superpowers/plans/` are **dated design
records**. Don't edit them post-hoc. If a design changes, write a new dated
spec. `specs/2026-05-08-replay-mode-design.md` has a special preamble noting
where reality diverged from the spec — that's the convention to follow when
a spec drifts (an explicit "post-spec implementation note" at the top).

Useful starting points :

- `specs/2026-04-28-trading-flow-design.md` — overall architecture
- `specs/2026-04-29-feedback-loop-design.md` — lessons subsystem
- `specs/2026-05-08-replay-mode-design.md` — replay mode (incl. §10
  invariants)
- `specs/2026-04-30-indicators-modularization-design.md` — indicator plugins
- `specs/2026-04-29-market-hours-awareness-design.md` — market clock workflow

## Logging / observability

- `getLogger({ component: "..." })` from `@observability/logger` (pino — JSON
  in containers, pretty in dev).
- Health endpoints per worker : scheduler 8081, analysis 8082, notification
  8083, web 8084 (all 127.0.0.1-bound in dev only).

## Conventions

- Biome enforced (`bunx @biomejs/biome check`). Run `--write` before committing.
- Workflow file naming : `<domain>Workflow.ts` (e.g. `setupWorkflow.ts`,
  `replaySessionWorkflow.ts`, `schedulerWorkflow.ts`).
- Signals / queries : camelCase string names (`replayTick`, `getReplayState`).
- DB tables : `snake_case` plural (drizzle).
- Status / state-machine values : `UPPER_SNAKE` (`TRACKING`, `INVALIDATED`,
  `EXPIRED_NO_FILL`, ...). Constrained by Postgres `CHECK` constraints —
  adding a new value requires a migration.
- `setups.outcome` allowed values : see `setups_outcome_chk` in `schema.ts`.

## Default to Bun (project uses Bun ≥ 1.3)

Always `bun run <script>` / `bun test` / `bunx`. Project's `package.json`
scripts cover everything you'll need — prefer them over raw bun invocations.
`Bun.serve` is already wired in `src/client/server.ts`. Don't reach for
Express/Vite/Webpack-CLI/etc.

The project uses **`pg` + drizzle** (not `Bun.sql`), **`grammy`** for Telegram
(not Bun built-ins), **no Redis** (`Bun.redis` is irrelevant). When in doubt
about a runtime API, grep the existing code rather than reaching for a generic
Bun-idiomatic solution.
