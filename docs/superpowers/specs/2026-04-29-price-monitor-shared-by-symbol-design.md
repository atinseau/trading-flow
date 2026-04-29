# Price monitor scoped by symbol, lazy-spawned, shared across watches

**Date:** 2026-04-29
**Status:** Design approved, awaiting implementation plan

## Problem

Today, every watch has its own `priceMonitorWorkflow` (id: `price-monitor-${watchId}`).
This means two watches on the same asset (e.g. `btcusdt-1h` and `btcusdt-15m` for
swing + scalping) open two independent WebSocket subscriptions to Binance for the
exact same price stream. The waste compounds linearly with the number of watches
on a popular asset.

It also means the workflow is created at boot time (`bootstrapWatch`), even when
no setups exist — leaving 1 long-idle workflow per watch, polling the DB every
minute for setups that don't exist.

## Goal

The unit of price monitoring becomes the **`(symbol, source)`** pair, not the
watch. One workflow, one WebSocket, surveilling all alive setups for that
(symbol, source) regardless of which watch created them.

The workflow is created **lazily** when the first setup needing surveillance is
inserted, and exits gracefully when the last alive setup terminates.

## Non-goals

- No DB schema changes (`setups` already keys by `(asset, source)` semantically).
- No new env vars.
- No change to the WebSocket-based reactivity (still ms-level via `BinanceWsPriceFeed`).
- No change to the per-setup workflow (`setupWorkflow`) or its state machine.
- No change to the per-watch scheduler workflow.
- No back-compat with existing `price-monitor-${watchId}` workflows — they are
  terminated at deploy time (one-shot migration).

## Architecture

### Before

```
watch btcusdt-1h        watch btcusdt-15m
      │                       │
      ▼                       ▼
price-monitor-btcusdt-1h   price-monitor-btcusdt-15m
      │                       │
      ▼                       ▼
   Binance WS              Binance WS         ← 2 streams for the same symbol
```

### After

```
setup created (any watch on BTCUSDT/binance)
      │
      ▼
ensurePriceMonitorRunning("BTCUSDT", "binance")
      │  signalWithStart → idempotent
      ▼
price-monitor-binance-BTCUSDT  (single workflow)
      │
      ▼
   Binance WS  (single stream)
      │
      ▼
each tick → check ALL alive setups for (BTCUSDT, binance)
            regardless of watch_id
            signal trackingPrice / priceCheck per setup
```

### Lifecycle

```
empty state
   │
   ├── setup A created on BTCUSDT (watch=btcusdt-1h)
   │      └─ ensurePriceMonitorRunning(BTCUSDT, binance) → spawns workflow
   │      └─ WS opens, monitor starts
   │
   ├── setup B created on BTCUSDT (watch=btcusdt-15m)
   │      └─ ensurePriceMonitorRunning(BTCUSDT, binance) → no-op (already running)
   │      └─ next refresh of cachedSetups picks up setup B
   │
   ├── setup A → tp_hit → terminal status
   │      └─ activity refreshes cachedSetups, drops A
   │
   └── setup B → sl_hit → terminal status
          └─ activity refreshes cachedSetups, finds 0 alive
          └─ workflow exits gracefully
```

## Detailed changes

### `src/workflows/price-monitor/priceMonitorWorkflow.ts`

**Args change:**
```ts
// Before
export type PriceMonitorArgs = { watchId: string; adapter: string };
// After
export type PriceMonitorArgs = { symbol: string; source: string };
```

**Workflow ID change:**
```ts
// Before
export const priceMonitorWorkflowId = (watchId: string) => `price-monitor-${watchId}`;
// After
export const priceMonitorWorkflowId = (symbol: string, source: string) =>
  `price-monitor-${source}-${symbol}`;
```

**Body change:**
```ts
export async function priceMonitorWorkflow(args: PriceMonitorArgs): Promise<void> {
  let stop = false;
  setHandler(stopSignal, () => { stop = true; });

  // No more idle-poll loop. We only run when at least one setup exists.
  // The activity handles graceful exit when the alive set drains to zero.
  while (!stop) {
    const aliveSetups = await dbActivities.listAliveSetupsForSymbol({
      symbol: args.symbol,
      source: args.source,
    });
    if (aliveSetups.length === 0) {
      return;  // last setup died — exit
    }

    try {
      await longRunningActivities.subscribeAndCheckPriceFeed({
        symbol: args.symbol,
        source: args.source,
      });
    } catch (err) {
      if ((err as Error).message?.includes("StopRequestedError")) {
        // feed ended (network blip, retry); re-check setups before re-subscribe
        continue;
      }
      throw err;
    }
  }
}
```

The 60s idle-sleep loop is gone. The workflow is started by
`ensurePriceMonitorRunning` only when there's a setup to watch, and exits when
the last one dies.

### `src/workflows/price-monitor/activities.ts`

**Rename + rescope `listAliveSetupsWithInvalidation`:**
```ts
// Before
async listAliveSetupsWithInvalidation(input: { watchId: string }) {
  return deps.setupRepo.listAliveWithInvalidation(input.watchId);
}
// After
async listAliveSetupsForSymbol(input: { symbol: string; source: string }) {
  return deps.setupRepo.listAliveBySymbol(input.symbol, input.source);
}
```

A new repo method `listAliveBySymbol(symbol, source)` is added (the existing
`listAliveWithInvalidation(watchId)` stays for use elsewhere if any — to be
checked).

**Rescope `subscribeAndCheckPriceFeed`:**
```ts
// Before
async subscribeAndCheckPriceFeed(input: { watchId: string; adapter: string; assets: string[] })
// After
async subscribeAndCheckPriceFeed(input: { symbol: string; source: string })
```

Internally:
- Derive adapter from source via `pickPriceFeedAdapter(source)` (no longer caller-supplied)
- `feed.subscribe({ assets: [symbol] })` (single asset, no list)
- Refresh `cachedSetups` from `listAliveBySymbol(symbol, source)` every 60s
- **New exit condition**: after refresh, if `cachedSetups.length === 0`, return normally (no more `StopRequestedError` for this case — that's only for upstream feed errors)
- Loop body unchanged (TRACKING → trackingPrice signal; pre-TRACKING with invalidation → priceCheck signal)

**New activity `ensurePriceMonitorRunning`:**
```ts
async ensurePriceMonitorRunning(input: { symbol: string; source: string }): Promise<void> {
  const workflowId = priceMonitorWorkflowId(input.symbol, input.source);
  await deps.temporalClient.workflow
    .signalWithStart("priceMonitorWorkflow", {
      workflowId,
      taskQueue: deps.infra.temporal.task_queues.scheduler,
      args: [{ symbol: input.symbol, source: input.source }],
      signal: "noop",                     // dummy — workflow doesn't define this
      signalArgs: [],
    })
    .catch((err: Error) => {
      if (err.message?.match(/already.*started|alreadystarted/i)) return;
      throw err;
    });
}
```

Idempotent: if a workflow with this ID is already running, the call is a no-op.
If not, it spawns one. The signal is dummy (workflow ignores unknown signals);
we just need the "start if not running" semantic.

### `src/workflows/scheduler/activities.ts` — call site for `ensurePriceMonitorRunning`

When the scheduler activity creates a setup row in `setups`, immediately after
the INSERT, call `ensurePriceMonitorRunning({ symbol, source })`. This
guarantees a price monitor exists by the time the setup workflow may signal
`trackingPrice`.

Concretely: find the activity (likely `persistDetectorOutput` or similar) that
INSERTs into `setups`, append the call. The `(symbol, source)` come from the
watch config: `watch.asset.symbol`, `watch.asset.source`.

### `src/config/bootstrapWatch.ts` — drop the price monitor start

Remove the entire block that does:
```ts
await client.workflow.start("priceMonitorWorkflow", {
  args: [{ watchId: watch.id, adapter: pickPriceFeedAdapter(watch.asset.source) }],
  workflowId: priceMonitorWorkflowId(watch.id),
  taskQueue: taskQueues.scheduler,
})
```
The price monitor is no longer per-watch; it's spawned lazily.

### `src/config/tearDownWatch.ts` — drop the price monitor termination

Remove the part that signals stop on `priceMonitorWorkflowId(watchId)`. The
shared price monitor isn't tied to a single watch lifecycle anymore. It will
exit on its own when the last alive setup tied to its `(symbol, source)` is
closed.

### `src/cli/bootstrap-schedules.ts`

Same as bootstrapWatch — no price monitor start at boot reconcile.

### Migration: terminate stale per-watch price monitors

After deploying, the old `price-monitor-${watchId}` workflows still exist in
Temporal (Running). They'll stay Running until something stops them. Add a
one-shot CLI:

```
src/cli/migrate-price-monitors.ts
```

That:
1. Lists Temporal workflows with type `priceMonitorWorkflow` whose ID matches `price-monitor-*` but NOT the new `price-monitor-${source}-${symbol}` pattern
2. Sends `stop` signal to each (the workflow is set up to exit on stop)
3. Logs what was migrated

The user runs this once after deploy. It's safe to re-run (idempotent).

Alternative: `temporal workflow signal --query 'WorkflowType="priceMonitorWorkflow"' --name stop` from the CLI, no script needed. Document the command in the spec; no code change.

**Decision: documented one-liner, no script.** Keeps the migration simple.

## Test plan

1. **Unit test**: `listAliveSetupsForSymbol` — given setups across 2 watches with same symbol, returns both. Soft-deleted excluded.
2. **Unit test**: `ensurePriceMonitorRunning` — calling twice with same args spawns 1 workflow. Calling with different `(symbol, source)` spawns 2 distinct workflows.
3. **Integration test (existing)**: `priceMonitorWorkflow` with 0 setups exits immediately. With 1 setup it subscribes; when setup terminates, workflow exits.
4. **Manual e2e**: create 2 watches `btcusdt-1h` + `btcusdt-15m`, force-tick both to create setups, observe Temporal: only 1 `price-monitor-binance-BTCUSDT` running, both setups receive `trackingPrice` signals.

## Acceptance criteria

- `temporal workflow list` shows `price-monitor-*` workflows scoped by `(source, symbol)`, not `watchId`. Multiple watches on same asset → 1 workflow.
- The workflow exits cleanly when the alive setup count drops to 0 (no idle 60s polling loop).
- `bootstrapWatch.ts` and `tearDownWatch.ts` no longer touch price monitors.
- All existing tests pass; new tests for the by-symbol semantics pass.
- After running the migration command, no stale `price-monitor-${watchId}`-style workflows remain.

## Out of scope (deliberate)

- Multi-asset multiplexing within a single price monitor. Today (and after this
  spec), one workflow handles one (symbol, source). If a future requirement
  needs e.g. correlated assets in one stream, that's a separate refactor.
- Cross-source unification. `binance:BTCUSDT` and `yahoo:BTCUSDT` produce
  different workflows. Different sources have different price feeds, so this is
  the right boundary.
- Refactoring the WebSocket adapter to handle reconnects internally (the current
  retry-on-error pattern with the workflow loop is fine).
