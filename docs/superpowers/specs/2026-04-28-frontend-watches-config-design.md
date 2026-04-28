# Frontend `tf-web` — Configuration & Real-Time Monitoring

**Date**: 2026-04-28
**Status**: Approved (pending implementation plan)

## Context

Today, configuring `trading-flow` is a developer experience: edit `config/watches.yaml` by hand, run `bun run src/cli/reload-config.ts`, inspect setups via `bun run src/cli/list-setups.ts`, drill into details via `show-setup.ts`, watch logs via `docker compose logs -f`. Power-users only. The audience the bot is now targeting is **traders, not developers** — people who think in patterns, levels, and confidence, not in YAML and shell commands.

A second pain point: the bot is event-sourced and the data model is rich (13 event types, score deltas, LLM cost/latency per call, OHLCV snapshots, chart artifacts), yet none of this is presented in any human-readable surface. The trader has to either trust the Telegram notifications blindly or shell into Postgres / Drizzle Studio to understand *why* a setup confirmed or invalidated.

This spec introduces **`tf-web`**: a new web UI service that gives traders direct access to two things, without ever asking them to touch a YAML file or a CLI:

1. **Configuration of watches** — a friendly form-based editor, full validation, defaults applied automatically
2. **Live monitoring** — dashboard, live event stream, setup deep-dive (interactive trading chart, score evolution, full event timeline with LLM reasoning expanded inline)

The core invariant: **the bot itself is not modified**. Workflows, activities, scoring, prompts, state machine, and all adapters stay byte-for-byte unchanged. Only config-loading helpers and CLI thin-wrappers get refactored.

## Goals

1. **Trader-first UX** — vocabulary, defaults, progressive disclosure. No YAML in the UI. No jargon left unexplained (tooltips on every technical term).
2. **Watches config moves to Postgres**. The yaml-based source survives only for global infrastructure (`llm_providers`, `notifications.telegram`, `database`, `temporal`, `market_data`). The `watches:` array is read from a new `watch_configs` table.
3. **Real-time monitoring** with sub-2-second end-to-end latency, no manual refresh ever needed.
4. **No changes to the bot's runtime core**. Workflows, activities, scoring, prompts, state machine, adapters: untouched. Only config helpers (`loadConfig`, `bootstrap-schedules`, `reload-config`) get refactored to call shared primitives that `tf-web` reuses.
5. **One additional Docker container** (`tf-web`), one additional port (8084, bound to localhost), one additional Bun process. No new external dependencies (Postgres + Temporal already present).
6. **No authentication for now**. Surface is bound to `127.0.0.1` only. Auth gate is a follow-up project.

## Non-goals

- **Authentication / multi-user**. Local-only access; future spec.
- **Editing the global infra config (`llm_providers`, `telegram`, etc.) from the UI.** Operator concerns stay in YAML.
- **Mobile-first design**. Desktop-first, responsive enough to be readable on a tablet.
- **Importing existing watches.yaml automatically at boot**. A manual one-shot CLI handles migration; everyday UX is "DB is the source, UI is the editor".
- **Replacing the existing CLIs.** They continue to work and remain useful for scripting / power-users.
- **Live price feed in the trading chart for v1.** Chart shows OHLCV from the latest tick snapshot; live tick is a future enhancement.

## Decisions

The following decisions were validated in brainstorming and frame the rest of this document:

| # | Decision |
|---|---|
| D1 | Watches[] config moves to Postgres (new `watch_configs` table). YAML stays for global infra (`llm_providers`, `notifications.telegram`, `database`, `temporal`, `market_data`). |
| D2 | Single `tf-web` container running `bun run src/client/server.ts` — Bun.serve hosts both the React frontend (HTML imports) and the `/api/*` REST + SSE endpoints. |
| D3 | Real-time via SSE + 1.5s polling of DB inside `tf-web` (no `LISTEN/NOTIFY`, no touch on workers). |
| D4 | Form UI: trader-friendly, multi-section (Asset / Schedule / Lifecycle / Analyzers / Notifications / Budget), advanced fields collapsed under an *Advanced* accordion. No YAML editor exposed. |
| D5 | Four pages (Dashboard, Watch detail, Setup detail, Costs) + a *Live events* full-screen route. Admin actions (Force tick, Pause, Resume, Kill setup) exposed as buttons with confirmation modals. |
| D6 | Sidebar on the right hosts the global *Live events* feed permanently. Click on an event opens a modal with full detail (LLM reasoning, observations, fresh data, link back to setup). |
| D7 | Setup detail = 2-column layout: left = `lightweight-charts` interactive candlestick chart with horizontal level lines (Entry / SL / TP / Invalidation) + key levels recap cards; right = score evolution mini-chart + events timeline with inline expand. |
| D8 | shadcn/ui (CLI v3) + Tailwind v4 + Bun.serve HTML imports for bundling. shadcn `Chart` (Recharts under the hood) for score / cost charts. `lightweight-charts` (already in deps v4.2.3) for the trading chart. |

## Architecture

### High-level

```
┌─────────────────────────────────────────────────────────────────────┐
│                          docker-compose                              │
│                                                                      │
│  Postgres ◄────────────────────────────────────────────────┐         │
│      ▲                                                      │         │
│      │ (read/write)                                         │         │
│      │                                                      │         │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────┐ │
│  │ scheduler-w.  │  │ analysis-w.  │  │ notif-worker │  │ tf-web  │ │
│  │ (unchanged)   │  │ (unchanged)  │  │ (unchanged)  │  │  NEW    │ │
│  │               │  │              │  │              │  │ :8084   │ │
│  └───────────────┘  └──────────────┘  └──────────────┘  └────┬────┘ │
│         ▲                                                    │       │
│         │ Temporal signals (reload, kill, pause, force-tick) │       │
│         └────────────────────────────────────────────────────┘       │
│                                                                      │
│  Volumes: artifacts_data (read-only mount on tf-web)                 │
└─────────────────────────────────────────────────────────────────────┘

                   Browser (trader)
                        │
                        ▼  HTTP + SSE
                   http://localhost:8084
                        │
                        ▼
                   tf-web (Bun.serve, single process)
                   ├─ HTML imports (React 19 bundle, Tailwind v4 inline)
                   ├─ /api/* (REST: Zod + Drizzle)
                   ├─ /api/stream (SSE)
                   └─ pollerLoop ◄── Postgres (read-only)
```

`tf-web` is **a DB reader/writer + a Temporal signaler**. It performs no analysis, no orchestration. The bot's runtime (Detector / Reviewer / Finalizer / state-machine / scoring) is strictly untouched.

### Touch points on existing code (config-loaders only — not core logic)

| File | Change |
|---|---|
| `src/config/loadConfig.ts` | Read `watches[]` from DB instead of YAML; rest of YAML still parsed for global infra. |
| `src/cli/bootstrap-schedules.ts` | Becomes a thin wrapper over `bootstrapWatch(config)` extracted into `src/config/bootstrapWatch.ts`. Reads watches from DB. |
| `src/cli/reload-config.ts` | Becomes a thin wrapper over `applyReload({...})` extracted into `src/config/applyReload.ts`. |
| `src/cli/pause-watch.ts`, `kill-setup.ts`, `force-tick.ts` | Become thin wrappers over helpers in `src/config/watchOps.ts`. |

These extractions create a **shared internal API** that both CLIs and `tf-web` consume. No duplication of logic. Existing CLI behavior preserved.

### Internal structure (`src/client/`)

```
src/client/
├── server.ts                       # Entry — Bun.serve()
├── index.html                      # HTML imports (React bundle entry)
├── frontend.tsx                    # React root + QueryClientProvider + RouterProvider
├── globals.css                     # Tailwind v4 (@import "tailwindcss") + CSS variables shadcn (dark theme)
├── api/
│   ├── routes.ts                   # Path → handler mapping (Bun.serve routes object)
│   ├── watches.ts                  # CRUD watch_configs + revisions
│   ├── setups.ts                   # Read setups + events + chart data
│   ├── events.ts                   # Global event feed (paginated)
│   ├── ticks.ts                    # tick_snapshots + artifact streaming
│   ├── costs.ts                    # LLM cost aggregations
│   ├── admin.ts                    # Force-tick / Pause / Resume / Kill (Temporal signals)
│   └── stream.ts                   # SSE endpoint
├── lib/
│   ├── db.ts                       # Drizzle pool (reuses src/adapters/persistence/schema)
│   ├── temporal.ts                 # Temporal Client wrapper
│   ├── broadcaster.ts              # In-process pub/sub for SSE fan-out
│   ├── poller.ts                   # Polls events / setups / ticks / watch_states
│   ├── watchConfigService.ts       # CRUD watch_configs + applyReload trigger
│   ├── artifacts.ts                # Stream PNG / OHLCV JSON from /data/artifacts (RO)
│   └── logger.ts                   # pino child logger
├── routes/
│   ├── root.tsx                    # Layout: header + LiveEventsSidebar
│   ├── dashboard.tsx               # /
│   ├── watch.tsx                   # /watches/:id
│   ├── watch-new.tsx               # /watches/new
│   ├── setup.tsx                   # /setups/:id
│   ├── live-events.tsx             # /live-events
│   ├── costs.tsx                   # /costs
│   └── error.tsx                   # ErrorBoundary
├── components/
│   ├── ui/                         # shadcn primitives (added via `shadcn add`)
│   ├── live-events-sidebar.tsx
│   ├── event-detail-modal.tsx
│   ├── watch-card.tsx
│   ├── watch-form/                 # 7 sub-sections + advanced accordion
│   ├── setup/                      # tv-chart, score-chart, events-timeline, key-levels
│   └── shared/
├── hooks/
│   ├── useSSEStream.ts             # Single SSE consumer → TanStack invalidation
│   ├── useWatch.ts
│   ├── useSetup.ts
│   ├── useEvents.ts
│   └── useAdminAction.ts
└── types.ts                        # Re-exports from @domain/* + DTOs
```

## Data model

### New tables (Postgres)

```sql
CREATE TABLE watch_configs (
  id           text         PRIMARY KEY,
  enabled      boolean      NOT NULL DEFAULT true,
  config       jsonb        NOT NULL,                  -- WatchConfig (Zod-validated on write)
  version      integer      NOT NULL DEFAULT 1,        -- bumped on every update (optimistic concurrency)
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  deleted_at   timestamptz                             -- soft delete (workers ignore if not NULL)
);
CREATE INDEX idx_watch_configs_enabled
  ON watch_configs(enabled) WHERE deleted_at IS NULL;

CREATE TABLE watch_config_revisions (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id     text         NOT NULL REFERENCES watch_configs(id) ON DELETE CASCADE,
  config       jsonb        NOT NULL,
  version      integer      NOT NULL,
  applied_at   timestamptz  NOT NULL DEFAULT now(),
  applied_by   text         NOT NULL DEFAULT 'ui'      -- 'ui' | 'cli' | 'seed'
);
CREATE INDEX idx_watch_revisions_watch
  ON watch_config_revisions(watch_id, applied_at DESC);
```

**JSONB choice rationale**: `WatchConfig` has 6+ levels of nesting (`analyzers.detector.fetch_higher_timeframe`, etc.). JSONB gives us flexibility, full Zod validation on write, and queries are always `WHERE id = ?` or `WHERE enabled = true` — no need for column-level filtering on nested paths.

### Existing tables (read-only from `tf-web`)

| Table | Purpose for `tf-web` |
|---|---|
| `watch_states` | Runtime metrics: `last_tick_at`, `total_cost_usd_mtd`, `setups_created_mtd`, `setups_confirmed_mtd` |
| `setups` | Lifecycle status, score, direction, TTL, workflowId |
| `events` | Event timeline (with `payload` jsonb, `provider`, `model`, `cost_usd`, `latency_ms`) |
| `tick_snapshots` | OHLCV URI + chart URI for the latest tick of each watch |
| `artifacts` | PNG charts and OHLCV JSON files (streamed via API to the browser) |

No migration on existing tables. Drizzle-kit generates a single migration adding the two new tables.

### Source-of-truth merge in `loadConfig`

```ts
// src/config/loadConfig.ts (after refactor)
export async function loadConfig(): Promise<Config> {
  const yaml = await loadYaml();                          // global infra (unchanged)
  const watches = await loadWatchesFromDb();              // NEW
  return ConfigSchema.parse({ ...yaml, watches });
}
```

The `Config` type emitted by `loadConfig` is bit-for-bit identical post-refactor — workers consume the same shape. Only the source of `watches[]` changed.

The `watches.yaml.example` template is updated: its `watches:` section becomes a comment that says "manage these in the UI (`http://localhost:8084`)". The example becomes purely about global infra.

## Backend (`tf-web`)

### Bun.serve composition

```ts
// src/client/server.ts (sketch)
import index from "./index.html";
import * as W from "./api/watches";
import * as S from "./api/setups";
// ... etc.

Bun.serve({
  port: Number(process.env.WEB_PORT ?? 8084),
  routes: {
    "/":                              index,
    "/health":                        { GET: health },

    // Watches CRUD
    "/api/watches":                   { GET: W.list, POST: W.create },
    "/api/watches/:id":               { GET: W.get, PUT: W.update, DELETE: W.del },
    "/api/watches/:id/revisions":     { GET: W.revisions },

    // Monitoring
    "/api/setups":                    { GET: S.list },          // ?watchId&status&limit
    "/api/setups/:id":                { GET: S.get },
    "/api/setups/:id/events":         { GET: S.events },
    "/api/setups/:id/ohlcv":          { GET: S.ohlcv },         // JSON for lightweight-charts
    "/api/events":                    { GET: E.list },          // ?since&watchId&limit
    "/api/ticks":                     { GET: T.list },          // ?watchId&limit
    "/api/ticks/:id/chart.png":       { GET: T.chartPng },      // proxy artifact (mime image/png)
    "/api/costs":                     { GET: C.aggregations },  // ?from&to&groupBy

    // Admin (Temporal signals)
    "/api/watches/:id/force-tick":    { POST: A.forceTick },
    "/api/watches/:id/pause":         { POST: A.pause },
    "/api/watches/:id/resume":        { POST: A.resume },
    "/api/setups/:id/kill":           { POST: A.killSetup },

    // Real-time
    "/api/stream":                    { GET: stream.sse },      // ?topics=events,setups,ticks,watches
  },
  development: {
    hmr: process.env.NODE_ENV !== "production",
    console: true,
  },
});
```

### Conventions

- **Validation** — Zod on every write payload. `WatchSchema` from `@domain/schemas/Config` is reused as-is on both server (input validation) and client (RHF resolver). Single source of truth.
- **Errors** — `safeHandler()` middleware wraps each handler: catches exceptions, logs with correlation ID, returns `Response.json({ error, code }, { status })`. Validation errors → 400. Concurrency conflicts → 409. Not found → 404. Other → 500.
- **Logging** — pino child logger from `@observability/logger` with `{ component: "tf-web" }`. Correlation ID injected per request (incoming `X-Request-Id` header if present, otherwise `crypto.randomUUID()` — note: do not use Temporal's deterministic `uuid4` here, that one is workflow-only).
- **DB pool** — single `pg.Pool` shared, `DATABASE_URL` env. Drizzle instance singleton.
- **Temporal client** — single `WorkflowClient` reused. `TEMPORAL_ADDRESS` env.
- **Path aliases** — `@domain/*`, `@adapters/*`, `@observability/*` reused. `@client/*` added in `tsconfig.json` paths.
- **Bind** — `127.0.0.1` only via Docker port mapping. No auth ⇒ no remote exposure.

## Frontend

### Stack

| Layer | Tool | Install |
|---|---|---|
| Bundler | Bun.serve HTML imports (Tailwind v4 + TSX native) | (built-in) |
| Framework | React 19 | `bun add react react-dom @types/react @types/react-dom` |
| Styling | Tailwind v4 | `bun add tailwindcss tailwindcss-animate` |
| Components | shadcn/ui | `bunx shadcn@latest init` then `add ...` |
| Router | react-router-dom v7 | `bun add react-router-dom` |
| Server state | TanStack Query v5 | `bun add @tanstack/react-query` |
| Forms | RHF + Zod resolver | `bun add react-hook-form @hookform/resolvers` |
| Trading chart | lightweight-charts (4.2.3) | already in deps |
| Generic charts | recharts (via shadcn `chart`) | pulled by `shadcn add chart` |
| Icons | lucide-react | pulled by shadcn |
| Date | date-fns | `bun add date-fns` |

### shadcn setup

```bash
# 1. Initialize shadcn (manual prompts: TypeScript=yes, style=default, base=neutral, CSS file=src/client/globals.css)
bunx shadcn@latest init

# 2. Add all components in one go
bunx shadcn@latest add \
  button card badge tabs dialog sheet drawer accordion separator skeleton \
  form input select switch slider tooltip sonner table chart
```

`components.json`:

```jsonc
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",                             // Tailwind v4 = CSS-first
    "css": "src/client/globals.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@client/components",
    "ui":         "@client/components/ui",
    "utils":      "@client/lib/utils",
    "lib":        "@client/lib",
    "hooks":      "@client/hooks"
  }
}
```

`globals.css` enables Tailwind and declares the dark-theme CSS variables shadcn expects:

```css
@import "tailwindcss";
@plugin "tailwindcss-animate";

@layer base {
  :root {
    --background: 0 0% 4%;
    --foreground: 0 0% 95%;
    /* ...rest generated by shadcn init... */
    --chart-1: 220 70% 60%;
    --chart-2: 160 60% 50%;
    --chart-3: 30 80% 60%;
    --chart-4: 280 70% 60%;
    --chart-5: 0 70% 60%;
  }
}
```

Tailwind + Bun pipeline: use `bun-plugin-tailwind` (the official Bun plugin documented on [bun.com/docs/bundler/html-static](https://bun.com/docs/bundler/html-static.md)) registered via `bunfig.toml` under `[serve.static]`. Tailwind v4 itself is CSS-first — no `tailwind.config.js`, no PostCSS, no Vite plugin. **Implementation note**: at time of writing, `bun-plugin-tailwind` is officially documented for Tailwind v3. The implementation plan must verify v4 compatibility on day 1 — if v4 is not yet supported, two acceptable fallbacks: (a) pin Tailwind to v3 for v1 of `tf-web` (no impact on shadcn since shadcn supports both), or (b) run `tailwindcss-cli --watch` as a co-process producing the bundled CSS that Bun.serve serves as a static asset. Decision deferred to the plan, with v4 + plugin as the preferred outcome.

### Routing

```tsx
// frontend.tsx
const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,                  // header + LiveEventsSidebar (always visible)
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "watches/new", element: <WatchNew /> },
      { path: "watches/:id", element: <WatchDetail /> },
      { path: "setups/:id", element: <SetupDetail /> },
      { path: "live-events", element: <LiveEventsFull /> },
      { path: "costs", element: <Costs /> },
    ],
  },
]);
```

### TanStack Query keys & invalidation

| Query key | Endpoint | staleTime | Invalidated by |
|---|---|---|---|
| `["watches"]` | `GET /api/watches` | 30s | SSE `watches`, mutation save |
| `["watches", id]` | `GET /api/watches/:id` | 30s | SSE `watches`, mutation save |
| `["setups", { watchId, status }]` | `GET /api/setups?...` | 5s | SSE `setups` |
| `["setups", id]` | `GET /api/setups/:id` | 5s | SSE `setups`, SSE `events` (filtered) |
| `["setups", id, "events"]` | `GET /api/setups/:id/events` | 5s | SSE `events` (filtered) |
| `["setups", id, "ohlcv"]` | `GET /api/setups/:id/ohlcv` | 60s | SSE `ticks` (filtered) |
| `["events"]` | `GET /api/events?...` | 2s | SSE `events` |
| `["events", "live"]` | (in-memory, populated by SSE) | ∞ | SSE `events` (`setQueryData`, no refetch) |
| `["costs", filters]` | `GET /api/costs?...` | 60s | SSE `events` |

Single `useSSEStream()` invocation in `<RootLayout />` opens a single `EventSource("/api/stream?topics=events,setups,watches,ticks")`. The hook dispatches each message to either `queryClient.invalidateQueries(...)` (for detail views — fetch fresh) or `queryClient.setQueryData(...)` (for the Live events sidebar — push directly, no refetch).

### Forms

```tsx
// src/client/components/watch-form/index.tsx (sketch)
const form = useForm<WatchConfig>({
  resolver: zodResolver(WatchSchema),               // re-uses @domain/schemas/Config
  defaultValues: existing ?? sensibleDefaults,
});

return (
  <Form {...form}>
    <SectionAsset />
    <SectionSchedule />
    <SectionLifecycle />
    <SectionAnalyzers />
    <SectionNotifications />
    <SectionBudget />
    <Accordion><SectionAdvanced /></Accordion>      {/* pre_filter, dedup, history_compaction, optimization */}
    <FormActions onSubmit={...} />
  </Form>
);
```

Zod paths surface as `formState.errors[<dot.path>]` — RHF + zodResolver maps automatically when field `name="schedule.detector_cron"` matches Zod's `path: ["schedule", "detector_cron"]`.

## Config write flow

### Helper extraction

The CLIs `bootstrap-schedules.ts`, `reload-config.ts`, `pause-watch.ts`, `kill-setup.ts`, `force-tick.ts` move their inline logic into reusable modules:

```
src/config/
├── loadConfig.ts                  # (refactor) DB for watches[], YAML for the rest
├── applyReload.ts                 # NEW — diff old/new + Temporal signals
├── bootstrapWatch.ts              # NEW — Schedule + SchedulerWorkflow + PriceMonitor
├── tearDownWatch.ts               # NEW — delete Schedule + terminate workflows
└── watchOps.ts                    # NEW — pauseWatch, resumeWatch, forceTick, killSetup
```

CLIs become thin wrappers:

```ts
// src/cli/reload-config.ts (after refactor)
import { applyReload } from "@config/applyReload";
const result = await applyReload({ dryRun: argv["--dry-run"] });
console.log(result.summary);
```

`tf-web` imports the same primitives:

```ts
// src/client/lib/watchConfigService.ts
import { applyReload } from "@config/applyReload";
import { bootstrapWatch } from "@config/bootstrapWatch";
import { tearDownWatch } from "@config/tearDownWatch";
```

### Per-operation flow

#### Create — `POST /api/watches`

1. Zod-validate body against `WatchSchema`.
2. Reject 409 if id already exists in `watch_configs`.
3. DB transaction: INSERT `watch_configs` (version=1) + INSERT `watch_config_revisions` (`applied_by='ui'`).
4. Outside the transaction: `bootstrapWatch(config)` — creates Schedule, starts SchedulerWorkflow + PriceMonitorWorkflow.
5. Return 201 with the created config.

#### Update — `PUT /api/watches/:id`

1. Zod-validate body. Body includes `version` field (current version client has).
2. DB transaction: `UPDATE watch_configs SET config=$, version=version+1 WHERE id=$ AND version=$expected`. If 0 rows updated → 409 ConflictError.
3. INSERT revision row.
4. Outside the transaction: `applyReload({ watchId })`. The helper diffs the previous config against the new one and:
   - If `schedule.detector_cron` changed → `client.schedule.update(...)` (cron expression).
   - For all other fields → `client.workflow.signal(schedulerWorkflowId, "reloadConfig")`. The workflow re-reads `loadConfig()` and applies on next tick (no restart).
5. Return 200.

#### Soft-delete — `DELETE /api/watches/:id`

1. UPDATE `watch_configs SET deleted_at = now(), enabled = false`.
2. `tearDownWatch(watchId)` — delete Schedule + terminate the long-lived workflows.
3. Return 204.

#### Admin actions

| Endpoint | Helper | Effect |
|---|---|---|
| `POST /api/watches/:id/force-tick` | `forceTick(id)` | `client.schedule.trigger(scheduleId)` |
| `POST /api/watches/:id/pause` | `pauseWatch(id)` | Schedule pause + `enabled=false` in DB |
| `POST /api/watches/:id/resume` | `resumeWatch(id)` | Schedule unpause + `enabled=true` in DB |
| `POST /api/setups/:id/kill` | `killSetup(setupId, reason)` | Signal `kill` to SetupWorkflow |

All actions log with correlation ID, return `{ status: "ok", appliedAt: timestamp }`. The client invalidates affected TanStack queries on success and shows a `Sonner` toast.

### Concurrency & idempotency

- **Optimistic concurrency** on `watch_configs.version` — lost updates produce a clear 409 with a "reload and retry" message.
- `bootstrapWatch` and `tearDownWatch` are idempotent: they check existence (workflow `describe()`, schedule `getHandle().describe()`) before create/delete and treat "already exists" / "not found" as success.

## Real-time read flow

### Internal architecture

```
┌─────────────────────────────────────────────────────────────┐
│  tf-web process                                              │
│                                                              │
│   ┌──────────────┐   poll 1.5s                              │
│   │  PollerLoop  │ ──────────────► Postgres (read-only)     │
│   │              │                                           │
│   │ - eventsCur  │ ◄──── new rows                            │
│   │ - setupsCur  │                                           │
│   │ - ticksCur   │                                           │
│   │ - watchesCur │                                           │
│   └──────┬───────┘                                           │
│          │ emit                                              │
│          ▼                                                   │
│   ┌──────────────┐                                           │
│   │ Broadcaster  │  Map<topic, Set<subscriber>>              │
│   └──────┬───────┘                                           │
│          │ fan-out                                           │
│          ▼                                                   │
│   ┌─────────────────────────────────┐                        │
│   │  SSE handlers (1 per client)    │                        │
│   └──────────────────┬──────────────┘                        │
└──────────────────────┼───────────────────────────────────────┘
                       │ text/event-stream
                       ▼
                  Browser EventSource
                       │
                       ▼
              useSSEStream hook
                       │
                       ▼
            queryClient.invalidate / setQueryData
```

### PollerLoop — cursors

| Source | Cursor | Query |
|---|---|---|
| `events` | `last_event_at` (timestamptz) | `SELECT * FROM events WHERE occurred_at > $cursor ORDER BY occurred_at, id LIMIT 200` |
| `setups` | `last_setup_updated_at` | `SELECT * FROM setups WHERE updated_at > $cursor LIMIT 200` |
| `tick_snapshots` | `last_tick_created_at` | `SELECT * FROM tick_snapshots WHERE created_at > $cursor LIMIT 50` |
| `watch_states` | `last_watch_updated_at` | `SELECT * FROM watch_states WHERE last_tick_at > $cursor LIMIT 50` |

- Cursors live in memory; persistence is unnecessary because boot resync at `now() - 5s` covers crash recovery (any older event is already reflected in the DB and TanStack will pick it up via REST queries).
- Anti-jitter: a 200ms safety window on each poll prevents missing events that committed within the same millisecond as the cursor.
- Configurable via env: `TF_WEB_POLL_INTERVAL_MS=1500`, `TF_WEB_POLL_BATCH_SIZE=200`.
- Backpressure: `setTimeout(_, max(0, interval - elapsed))`. If a poll lags > 5s, log warn.

### Broadcaster — fan-out

```ts
class Broadcaster {
  private subs = new Map<Topic, Set<Subscriber>>();

  subscribe(topics: Topic[], sub: Subscriber): () => void {
    for (const t of topics) {
      if (!this.subs.has(t)) this.subs.set(t, new Set());
      this.subs.get(t)!.add(sub);
    }
    return () => topics.forEach(t => this.subs.get(t)?.delete(sub));
  }

  emit(topic: Topic, payload: unknown): void {
    const subs = this.subs.get(topic);
    if (subs) for (const s of subs) s.send(topic, payload);
  }
}
```

Topics: `"events" | "setups" | "watches" | "ticks"`. No fine-grained server-side filtering by `watchId` / `setupId` (volume is trivial: < 50 events/min) — clients filter.

### SSE endpoint — `/api/stream`

```ts
function sseStream(req: Request): Response {
  const url = new URL(req.url);
  const topics = (url.searchParams.get("topics") ?? "events,setups,watches,ticks").split(",") as Topic[];

  const stream = new ReadableStream({
    start(controller) {
      const subscriber = {
        send: (topic: Topic, payload: unknown) => {
          const id = (payload as any).id ?? Date.now();
          const msg = `id: ${id}\nevent: ${topic}\ndata: ${JSON.stringify(payload)}\n\n`;
          controller.enqueue(new TextEncoder().encode(msg));
        }
      };
      const unsub = broadcaster.subscribe(topics, subscriber);

      const heartbeat = setInterval(() => {
        controller.enqueue(new TextEncoder().encode(`: heartbeat\n\n`));
      }, 25_000);

      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsub();
        controller.close();
      });
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    }
  });
}
```

- **Reconnect**: `EventSource` re-emits with `Last-Event-ID` header on reconnect. If present, server fetches missed events from DB (`WHERE id > lastEventId LIMIT N`).
- **Heartbeat**: `: heartbeat\n\n` every 25s keeps proxies / load balancers from killing idle streams.

### Client hook — `useSSEStream`

```ts
export function useSSEStream() {
  const qc = useQueryClient();

  useEffect(() => {
    const sse = new EventSource("/api/stream?topics=events,setups,watches,ticks");

    sse.addEventListener("events", (e) => {
      const evt: EventRecord = JSON.parse((e as MessageEvent).data);
      qc.setQueryData<EventRecord[]>(["events", "live"], (old = []) => [evt, ...old].slice(0, 100));
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

    sse.addEventListener("ticks", (e) => {
      const tick: TickSummary = JSON.parse((e as MessageEvent).data);
      qc.invalidateQueries({ queryKey: ["ticks", tick.watchId] });
      qc.invalidateQueries({ queryKey: ["watches", tick.watchId] });
    });

    return () => sse.close();
  }, [qc]);
}
```

Single SSE per browser tab, single instantiation in `<RootLayout />`.

### Latency budget

```
event persisted in DB
   │
   │ ≤ 1.5s (poll interval)
   ▼
Poller detects
   │
   │ ≤ 5ms (in-process broadcast)
   ▼
SSE push
   │
   │ ≤ 50ms (local network)
   ▼
TanStack invalidate + refetch (≤ 100ms typical)
   │
   ▼
UI updated   ≈ 1.6–2s end-to-end
```

Sufficient for trading monitoring. Live events sidebar appears instantly via `setQueryData`; detail views refresh in the next tick.

## Docker integration

### Reuse `Dockerfile.worker`

The existing `Dockerfile.worker` is generic (`FROM oven/bun:1.3`, `bun install`, `COPY . .`). Workers and one-shot CLIs already use it with different `command:` values. `tf-web` does the same — no new Dockerfile to maintain. No build step for the frontend; Bun.serve handles TSX + Tailwind v4 + CSS imports at runtime.

### `docker-compose.yml` — modifications

Two changes, no new one-shot services:

**1. `bootstrap-schedules` — unchanged at the dependency level.** Boot reads watches from DB; if empty, no-op. New watches created via UI are bootstrapped in-process by `tf-web` calling the same `bootstrapWatch()` helper.

**2. New service `tf-web`:**

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
  volumes:
    - ./config:/app/config:ro
    - ./prompts:/app/prompts:ro
    - artifacts_data:/data/artifacts:ro      # READ-ONLY (PNG charts + OHLCV JSON streaming)
  command: bun run src/client/server.ts
  ports:
    - "127.0.0.1:8084:8084"                  # localhost-only — no auth yet
  healthcheck:
    test: ["CMD-SHELL", "wget -q -O - http://localhost:8084/health || exit 1"]
    interval: 10s
    timeout: 3s
    retries: 3
    start_period: 20s
```

### Final boot order

```
1. postgres                  ~5s
2. temporal                  ~30s
3. temporal-ui               ~5s
4. migrate                   one-shot — applies new tables (and any future migrations)
5. bootstrap-schedules       one-shot — iterates watches in DB (empty on first boot = no-op)
6. scheduler-worker          long-running ┐
7. analysis-worker           long-running ├ unchanged
8. notification-worker       long-running ┘
9. tf-web                    long-running NEW :8084
```

### Migration path for existing deployments

Operators with a populated `config/watches.yaml` run **once**:

```bash
bun run src/cli/seed-watches-from-yaml.ts
```

This CLI is idempotent (skips ids already present in DB). It is not part of `docker-compose.yml` to keep boot logic clean — it's a manual migration tool, documented in `README.md`.

### Dev mode (HMR)

Either:
- `tf-web` outside Docker: `bun --hot src/client/server.ts` against the rest of the stack running in compose.
- `docker-compose.override.yml` with bind mount on `./src` and `command: bun --hot src/client/server.ts`.

`Bun.serve` has HMR + console reroute natively (`development: { hmr: true, console: true }`).

### Security posture

- Bind `127.0.0.1` only — no network surface.
- Artifacts volume read-only.
- No secrets exposed to the frontend; the `.env` and YAML stay server-side.
- When auth is added (future spec), it gates `/api/*`. The bind can shift to `0.0.0.0` then.

## Testing

Follows the existing 4-level pattern. New directory `test/client/`. `bun test` picks them up automatically; E2E gated by `RUN_E2E=1` like other E2E tests.

```
test/
├── client/
│   ├── api/
│   │   ├── watches.test.ts                  # CRUD: Zod validation, version conflict (409), tx atomicity
│   │   ├── setups.test.ts                   # filters ?status=&watchId= + state join
│   │   ├── events.test.ts                   # cursor pagination, stable order
│   │   ├── admin.test.ts                    # force-tick / pause / resume / kill (Temporal mocked)
│   │   └── stream.test.ts                   # SSE protocol parse + heartbeat + cleanup
│   ├── lib/
│   │   ├── broadcaster.test.ts              # subscribe / emit / unsub, fan-out, no leak
│   │   ├── poller.test.ts                   # cursor advance, no duplicate, no miss
│   │   ├── watchConfigService.test.ts       # create / update / delete + applyReload triggered
│   │   └── artifacts.test.ts                # stream PNG / JSON, MIME, 404 if missing
│   └── frontend/
│       ├── hooks/
│       │   ├── useSSEStream.test.ts         # right TanStack invalidations on each topic
│       │   └── useAdminAction.test.ts       # success / error → toasts
│       └── components/
│           ├── watch-form.test.ts           # zodResolver(WatchSchema) surfaces errors on right paths
│           └── events-timeline.test.ts      # expand / collapse, click → onSelect
└── e2e/
    └── web-smoke.test.ts                    # Playwright, RUN_E2E=1
```

### Tooling additions

| Tool | Reason |
|---|---|
| `@happy-dom/global-registrator` | Lightweight DOM for hook / component tests. Bun-friendly. |
| `@testing-library/react` | Standard hook + component testing. |

Existing tools (testcontainers Postgres, Playwright, pino) cover the rest.

### Approach by layer

- **API handlers** — light integration: Postgres testcontainers + simple Temporal client mock (4 methods: `start`, `signal`, `triggerSchedule`, `terminate`). Spin up Bun.serve on a random port, hit it with `fetch`. Full payload → DB → response cycle verified.
- **`watchConfigService`** — pure integration: real Postgres, no HTTP. Verifies tx semantics, version conflicts, helper invocation.
- **`Poller`** — unit with in-memory rows mock. Verifies cursor advance, no missed rows, no duplicates, backpressure behavior.
- **`Broadcaster`** — pure unit, no I/O. Subscribers and fan-out / unsub.
- **SSE handler** — fetch in streaming, parse `event:` / `data:` frames, verify heartbeat (with Bun fake timers), cleanup on `req.signal.abort()`.
- **Frontend hooks** — happy-dom + RTL. Simulate SSE messages, assert `queryClient.invalidateQueries` calls.
- **Forms** — render `<WatchForm />`, submit invalid payload, assert Zod errors surface on the right field paths.
- **E2E** — Playwright drives a real browser against a running compose stack: load app, create watch, force tick, click event → modal visible.

### New scripts in `package.json`

```jsonc
{
  "scripts": {
    "test:client": "bun test test/client",
    "test:e2e:web": "RUN_E2E=1 bun test test/e2e/web-smoke.test.ts"
  }
}
```

### Coverage targets

| Layer | Target |
|---|---|
| API handlers | ~90% |
| `watchConfigService`, `bootstrapWatch`, `applyReload` helpers | ~95% |
| `Poller`, `Broadcaster` | ~90% |
| Hooks (`useSSEStream`, `useAdminAction`) | ~80% |
| Forms / Setup detail components | ~70% |
| Routes / pure layouts | not tested (visual / E2E) |

## Out-of-scope (potential follow-ups)

- **Authentication** (single-user password / passkey, then multi-user with roles).
- **Live price overlay** in the trading chart (Binance WS direct from frontend, or a `/api/live-price` proxy).
- **Indicator overlays** (RSI, EMA, ATR sub-panels in the Setup detail chart).
- **Multi-setup comparison view** (overlay scores of several setups for the same watch).
- **Watch templates** ("Crypto 1h preset", "Stocks daily preset") to pre-fill the create form.
- **Export / import** of watches as YAML for backup or sharing.
- **Live LLM call indicator** in the dashboard ("Detector is currently analyzing btc-1h...") — would require either a small `analysis_runs` table or Temporal API polling.
- **Audit log surfacing** in the UI (`watch_config_revisions` is already populated; just needs a viewer).

## Open questions

None at design time. The data model, write path, real-time path, and Docker integration are all closed loops with no missing pieces.
