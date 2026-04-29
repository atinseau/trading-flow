# Price monitor shared by symbol — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One `priceMonitorWorkflow` per `(symbol, source)` instead of per watch. Lazy spawn on first setup creation. Graceful exit when last alive setup terminates.

**Architecture:** Workflow ID `price-monitor-${source}-${symbol}`. New activity `ensurePriceMonitorRunning` (idempotent signalWithStart) called by the setup-creation activity. Repo gets a new `listAliveBySymbol(symbol, source)` method. Bootstrap and teardown stop touching price monitors.

**Tech Stack:** TypeScript, Bun, Drizzle, Temporal (`@temporalio/client`).

**Spec:** `docs/superpowers/specs/2026-04-29-price-monitor-shared-by-symbol-design.md`

---

## File Structure

**Files modified (8):**
- `src/domain/ports/SetupRepository.ts` — add `listAliveBySymbol(symbol, source)` to interface
- `src/adapters/persistence/PostgresSetupRepository.ts` — implement `listAliveBySymbol`
- `src/workflows/price-monitor/activities.ts` — rename + rescope listAlive activity, rescope subscribe activity, add `ensurePriceMonitorRunning`
- `src/workflows/price-monitor/priceMonitorWorkflow.ts` — change args, workflow id, body (drop idle-poll loop)
- `src/workflows/setup/activities.ts` — call `ensurePriceMonitorRunning` after `setupRepo.create`
- `src/config/bootstrapWatch.ts` — drop the price monitor `client.workflow.start` block
- `src/config/tearDownWatch.ts` — drop the price monitor stop signal
- `src/cli/bootstrap-schedules.ts` — no change required (delegated to bootstrapWatch); included only if needed

**Files unchanged:**
- DB schema (no migration)
- InfraConfig
- Setup workflow (`setupWorkflow.ts`) — still signals its own `trackingPrice` / `priceCheck`; the price monitor sends those signals
- Scheduler workflow (`schedulerWorkflow.ts`)

**Tests touched:**
- `test/workflows/price-monitor/*.test.ts` (if exists) — adapt
- `test/config/bootstrapWatch.test.ts`, `test/config/tearDownWatch.test.ts` — drop the price monitor expectations
- New tests for `listAliveBySymbol` + `ensurePriceMonitorRunning`

---

## Task 1: Add `listAliveBySymbol` to SetupRepository

**Files:**
- Modify: `src/domain/ports/SetupRepository.ts`
- Modify: `src/adapters/persistence/PostgresSetupRepository.ts`

- [ ] **Step 1: Read current `listAliveWithInvalidation` to mirror its return shape**

```bash
grep -n "AliveSetupSummary" src/adapters/persistence/PostgresSetupRepository.ts src/domain/ports/SetupRepository.ts
```

- [ ] **Step 2: Add to the port interface**

In `src/domain/ports/SetupRepository.ts`, add a method:
```ts
listAliveBySymbol(symbol: string, source: string): Promise<AliveSetupSummary[]>;
```

Place it near the existing `listAliveWithInvalidation` declaration. Keep `listAliveWithInvalidation` for now (might still be used elsewhere; remove only if grep confirms zero callers post-refactor).

- [ ] **Step 3: Implement in `PostgresSetupRepository`**

Open `src/adapters/persistence/PostgresSetupRepository.ts`. Find the existing `listAliveWithInvalidation` method (around line 52). Add a sibling method that filters by `(asset, ?)` — note that `setups.asset` only stores the symbol, NOT the source. The source isn't on the row directly; it's a property of the watch (`watch_configs.config.asset.source`).

Implementation strategy: JOIN against `watch_configs` to filter by `config->'asset'->>'source' = ?`:

```ts
async listAliveBySymbol(symbol: string, source: string): Promise<AliveSetupSummary[]> {
  const rows = await this.db
    .select({
      id: setups.id,
      watchId: setups.watchId,
      asset: setups.asset,
      direction: setups.direction,
      status: setups.status,
      invalidationLevel: setups.invalidationLevel,
      workflowId: setups.workflowId,
    })
    .from(setups)
    .innerJoin(watchConfigs, eq(setups.watchId, watchConfigs.id))
    .where(
      and(
        eq(setups.asset, symbol),
        sql`${watchConfigs.config}->'asset'->>'source' = ${source}`,
        notInArray(setups.status, [...TERMINAL_STATUSES]),
      ),
    );
  return rows.map(/* same shape transform as listAliveWithInvalidation */);
}
```

Adapt to the existing import pattern (drizzle imports, `TERMINAL_STATUSES` source, `AliveSetupSummary` type).

- [ ] **Step 4: Test**

Add to `test/adapters/persistence/PostgresSetupRepository.test.ts` (or create one if missing) a test that:
1. Inserts 2 watches with same `asset.source = "binance"` but different timeframes
2. Inserts 2 setups, one per watch, both with `asset = "BTCUSDT"`
3. Calls `listAliveBySymbol("BTCUSDT", "binance")` → expects 2 setups
4. Adds a third setup on a different symbol or different source → still returns 2

Run: `bun test test/adapters/persistence/PostgresSetupRepository.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/domain/ports/SetupRepository.ts src/adapters/persistence/PostgresSetupRepository.ts test/adapters/persistence/PostgresSetupRepository.test.ts
git commit -m "feat(repo): add listAliveBySymbol — joins watch_configs to filter by source"
```

---

## Task 2: Add `ensurePriceMonitorRunning` activity

**Files:**
- Modify: `src/workflows/price-monitor/activities.ts`

- [ ] **Step 1: Add the new activity**

In `src/workflows/price-monitor/activities.ts`, inside `buildPriceMonitorActivities`, add:

```ts
async ensurePriceMonitorRunning(input: { symbol: string; source: string }): Promise<void> {
  const workflowId = priceMonitorWorkflowId(input.symbol, input.source);
  try {
    await deps.temporalClient.workflow.start("priceMonitorWorkflow", {
      args: [{ symbol: input.symbol, source: input.source }],
      workflowId,
      taskQueue: deps.infra.temporal.task_queues.scheduler,
    });
    log.info({ workflowId }, "price monitor started");
  } catch (err) {
    if ((err as Error).message?.match(/already.*started|alreadystarted/i)) {
      // running already — idempotent, all good
      return;
    }
    throw err;
  }
}
```

Note: `priceMonitorWorkflowId` is updated in Task 3 to take `(symbol, source)`. To compile cleanly, add Task 3's signature change first OR temporarily inline the ID:
```ts
const workflowId = `price-monitor-${input.source}-${input.symbol}`;
```
Then Task 3 unifies. Recommend the latter — simpler ordering.

- [ ] **Step 2: Lint check**

Run: `bunx @biomejs/biome check src/workflows/price-monitor/activities.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/workflows/price-monitor/activities.ts
git commit -m "feat(price-monitor): add idempotent ensurePriceMonitorRunning activity"
```

---

## Task 3: Refactor `priceMonitorWorkflow` — args, ID, body

**Files:**
- Modify: `src/workflows/price-monitor/priceMonitorWorkflow.ts`

- [ ] **Step 1: Replace the file**

Overwrite with:

```ts
import { defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "./activities";

const SHARED_NON_RETRYABLE = [
  "InvalidConfigError",
  "AssetNotFoundError",
  "LLMSchemaValidationError",
  "PromptTooLargeError",
  "NoProviderAvailableError",
  "CircularFallbackError",
  "StopRequestedError",
];

const dbActivities = proxyActivities<ReturnType<typeof activities.buildPriceMonitorActivities>>({
  startToCloseTimeout: "10s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "100ms",
    maximumInterval: "5s",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

const longRunningActivities = proxyActivities<
  ReturnType<typeof activities.buildPriceMonitorActivities>
>({
  startToCloseTimeout: "10m",
  heartbeatTimeout: "60s",
  retry: {
    maximumAttempts: 100,
    initialInterval: "5s",
    maximumInterval: "1m",
    nonRetryableErrorTypes: SHARED_NON_RETRYABLE,
  },
});

export type PriceMonitorArgs = { symbol: string; source: string };

export const stopSignal = defineSignal<[]>("stop");

export async function priceMonitorWorkflow(args: PriceMonitorArgs): Promise<void> {
  let stop = false;
  setHandler(stopSignal, () => {
    stop = true;
  });

  while (!stop) {
    const aliveSetups = await dbActivities.listAliveSetupsForSymbol({
      symbol: args.symbol,
      source: args.source,
    });
    if (aliveSetups.length === 0) {
      // Last alive setup terminated — exit gracefully. We're spawned again
      // lazily when a new setup is created on this (symbol, source).
      return;
    }

    try {
      await longRunningActivities.subscribeAndCheckPriceFeed({
        symbol: args.symbol,
        source: args.source,
      });
      // The activity returned without throwing — that means the alive set
      // drained inside the activity. Re-check at the top of the loop; will exit.
    } catch (err) {
      // Feed errored (network, etc). The proxy already retried up to limits.
      // Re-check the alive set at the top of the loop and decide.
      if (stop) return;
    }
  }
}

export const priceMonitorWorkflowId = (symbol: string, source: string): string =>
  `price-monitor-${source}-${symbol}`;
```

Key changes:
- `args` is `{ symbol, source }` instead of `{ watchId, adapter }`
- Workflow ID composed from `(source, symbol)`
- Activity name renamed to `listAliveSetupsForSymbol` (Task 4)
- Subscribe activity rescoped to `{ symbol, source }` (Task 4)
- Idle-poll loop dropped: when alive count hits zero, workflow exits

- [ ] **Step 2: Verify imports compile**

Run: `bunx @biomejs/biome check src/workflows/price-monitor/priceMonitorWorkflow.ts`
TypeScript will fail because `dbActivities.listAliveSetupsForSymbol` doesn't exist yet (we add it in Task 4) and `subscribeAndCheckPriceFeed` still has the old signature. **Don't run lint yet** — this task leaves a temporarily-incoherent state. Move directly to Task 4.

- [ ] **Step 3: Commit (yes, broken — Task 4 fixes immediately)**

```bash
git add src/workflows/price-monitor/priceMonitorWorkflow.ts
git commit -m "refactor(price-monitor): scope workflow by (symbol, source), drop idle-poll loop"
```

---

## Task 4: Refactor activities to match new workflow signature

**Files:**
- Modify: `src/workflows/price-monitor/activities.ts`

- [ ] **Step 1: Replace the file**

Overwrite with:

```ts
import { InvalidConfigError, StopRequestedError } from "@domain/errors";
import { getLogger } from "@observability/logger";
import { Context } from "@temporalio/activity";
import type { ActivityDeps } from "@workflows/activityDependencies";
import { priceMonitorWorkflowId } from "./priceMonitorWorkflow";

const log = getLogger({ component: "price-monitor-activities" });

const ADAPTER_BY_SOURCE: Record<string, string> = {
  binance: "binance_ws",
  yahoo: "yahoo_polling",
};

export function pickPriceFeedAdapter(assetSource: string): string {
  const a = ADAPTER_BY_SOURCE[assetSource];
  if (!a) throw new InvalidConfigError(`No price feed strategy for source ${assetSource}`);
  return a;
}

export function buildPriceMonitorActivities(deps: ActivityDeps) {
  return {
    async listAliveSetupsForSymbol(input: { symbol: string; source: string }) {
      return deps.setupRepo.listAliveBySymbol(input.symbol, input.source);
    },

    async ensurePriceMonitorRunning(input: { symbol: string; source: string }): Promise<void> {
      const workflowId = priceMonitorWorkflowId(input.symbol, input.source);
      try {
        await deps.temporalClient.workflow.start("priceMonitorWorkflow", {
          args: [{ symbol: input.symbol, source: input.source }],
          workflowId,
          taskQueue: deps.infra.temporal.task_queues.scheduler,
        });
        log.info({ workflowId }, "price monitor started");
      } catch (err) {
        if ((err as Error).message?.match(/already.*started|alreadystarted/i)) {
          return;
        }
        throw err;
      }
    },

    async subscribeAndCheckPriceFeed(input: {
      symbol: string;
      source: string;
    }): Promise<void> {
      const adapter = pickPriceFeedAdapter(input.source);
      const childLog = log.child({ symbol: input.symbol, source: input.source, adapter });
      const feed = deps.priceFeeds.get(adapter);
      if (!feed) throw new InvalidConfigError(`Unknown price feed adapter: ${adapter}`);

      childLog.info("subscribing to price feed");
      // PriceFeed.subscribe takes { watchId, assets } today; watchId is used as
      // a logging tag inside the adapter, not for routing. Pass the workflow
      // id for traceability.
      const stream = feed.subscribe({
        watchId: priceMonitorWorkflowId(input.symbol, input.source),
        assets: [input.symbol],
      });
      let lastRefresh = Date.now();
      let cachedSetups = await deps.setupRepo.listAliveBySymbol(input.symbol, input.source);

      for await (const tick of stream) {
        Context.current().heartbeat({ lastTickAt: tick.timestamp.toISOString() });

        if (Date.now() - lastRefresh > 60_000) {
          cachedSetups = await deps.setupRepo.listAliveBySymbol(input.symbol, input.source);
          lastRefresh = Date.now();
          if (cachedSetups.length === 0) {
            childLog.info("no alive setups remaining — exiting");
            return;
          }
        }

        for (const setup of cachedSetups) {
          if (setup.asset !== tick.asset) continue;

          if (setup.status === "TRACKING") {
            await deps.temporalClient.workflow
              .getHandle(setup.workflowId)
              .signal("trackingPrice", {
                currentPrice: tick.price,
                observedAt: tick.timestamp.toISOString(),
              })
              .catch((err: Error) =>
                childLog.warn(
                  { workflowId: setup.workflowId, err: err.message },
                  "trackingPrice signal failed (workflow may be closed)",
                ),
              );
            continue;
          }

          if (setup.invalidationLevel == null) continue;
          const breached =
            (setup.direction === "LONG" && tick.price < setup.invalidationLevel) ||
            (setup.direction === "SHORT" && tick.price > setup.invalidationLevel);
          if (breached) {
            await deps.temporalClient.workflow
              .getHandle(setup.workflowId)
              .signal("priceCheck", {
                currentPrice: tick.price,
                observedAt: tick.timestamp.toISOString(),
              })
              .catch((err: Error) =>
                childLog.warn(
                  { workflowId: setup.workflowId, err: err.message },
                  "priceCheck signal failed (workflow may be closed)",
                ),
              );
          }
        }
      }
      throw new StopRequestedError("price feed ended");
    },
  };
}
```

Changes vs before:
- `listAliveSetupsWithInvalidation(watchId)` → `listAliveSetupsForSymbol({symbol, source})`
- `subscribeAndCheckPriceFeed({watchId, adapter, assets})` → `({symbol, source})` (adapter derived inline)
- Inside subscribe: refresh exits early if cached setup count drops to 0 (avoids dangling for 60s)
- Added `ensurePriceMonitorRunning`

- [ ] **Step 2: Lint + type-check**

Run: `bunx @biomejs/biome check src/workflows/price-monitor/`
Expected: PASS for both files.

Run: `bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | head -10`
Expected: errors only in callers of the OLD activity names (Tasks 5-7 fix them).

- [ ] **Step 3: Commit**

```bash
git add src/workflows/price-monitor/activities.ts
git commit -m "refactor(price-monitor): rescope activities by (symbol, source) + add ensurePriceMonitorRunning"
```

---

## Task 5: Wire `ensurePriceMonitorRunning` after setup creation

**Files:**
- Modify: `src/workflows/setup/activities.ts`

- [ ] **Step 1: Locate the activity that calls `setupRepo.create`**

In `src/workflows/setup/activities.ts:38`. The activity receives `input` with fields including `watchId` and `asset`. The source isn't directly on the input; it's accessible via `deps.watchById(watchId)?.asset.source`.

- [ ] **Step 2: Append the call**

Right after `return deps.setupRepo.create({...})` — but the return is the row insert. Refactor to bind the result, then call ensure, then return:

```ts
async <existing-activity-name>(input: { ... watchId: string; asset: string; ... }) {
  const created = await deps.setupRepo.create({
    id: input.setupId,
    watchId: input.watchId,
    asset: input.asset,
    timeframe: input.timeframe,
    status: "REVIEWING",
    currentScore: input.initialScore,
    patternHint: input.patternHint,
    invalidationLevel: input.invalidationLevel,
    direction: input.direction,
    ttlCandles: input.ttlCandles,
    ttlExpiresAt: new Date(input.ttlExpiresAt),
    workflowId: input.workflowId,
  });
  const watch = deps.watchById(input.watchId);
  if (watch) {
    // Idempotent. Spawns price-monitor-${source}-${symbol} if not already running.
    await deps.temporalClient.workflow
      .start("priceMonitorWorkflow", {
        args: [{ symbol: input.asset, source: watch.asset.source }],
        workflowId: `price-monitor-${watch.asset.source}-${input.asset}`,
        taskQueue: deps.infra.temporal.task_queues.scheduler,
      })
      .catch((err: Error) => {
        if (!/already.*started|alreadystarted/i.test(err.message)) throw err;
      });
  }
  return created;
}
```

Why inline the workflow start instead of calling `ensurePriceMonitorRunning` activity from this activity? Activities can't call other activities directly; they call services via `deps`. The `temporalClient` is on `deps` already (used elsewhere in this file). Keep it inline + idempotent.

- [ ] **Step 3: Lint + type-check**

Run: `bunx @biomejs/biome check src/workflows/setup/activities.ts`

- [ ] **Step 4: Commit**

```bash
git add src/workflows/setup/activities.ts
git commit -m "feat(setup): spawn shared price monitor on setup creation (idempotent)"
```

---

## Task 6: Drop price monitor wiring from `bootstrapWatch` and `tearDownWatch`

**Files:**
- Modify: `src/config/bootstrapWatch.ts`
- Modify: `src/config/tearDownWatch.ts`

- [ ] **Step 1: `bootstrapWatch.ts` — remove the priceMonitorWorkflow start block**

In `src/config/bootstrapWatch.ts`, find and delete the entire block (around lines 37-45):
```ts
await client.workflow
  .start("priceMonitorWorkflow", {
    args: [{ watchId: watch.id, adapter: pickPriceFeedAdapter(watch.asset.source) }],
    workflowId: priceMonitorWorkflowId(watch.id),
    taskQueue: taskQueues.scheduler,
  })
  .catch((err: Error) => {
    if (!ALREADY_RUNNING.test(err.message)) throw err;
  });
```

Also drop the corresponding imports if they're now unused:
- `pickPriceFeedAdapter`
- `priceMonitorWorkflowId`

Keep the scheduler workflow start and the schedule create/update — those are still per-watch.

- [ ] **Step 2: `tearDownWatch.ts` — remove the price monitor stop signal**

Open `src/config/tearDownWatch.ts`. Find any block that signals `stop` on a `priceMonitorWorkflowId(watchId)`. Delete it. Drop unused imports.

If there are signals to other workflows (scheduler, schedule), keep those.

- [ ] **Step 3: Update tests**

`test/config/bootstrapWatch.test.ts` — remove assertions about `priceMonitorWorkflow.start` being called.
`test/config/tearDownWatch.test.ts` — remove assertions about price monitor stop.

Both tests likely use mocked `client.workflow` — adjust the mock setup and the expected call lists.

- [ ] **Step 4: Run tests**

```bash
bun test test/config/bootstrapWatch.test.ts test/config/tearDownWatch.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/bootstrapWatch.ts src/config/tearDownWatch.ts test/config/bootstrapWatch.test.ts test/config/tearDownWatch.test.ts
git commit -m "refactor(config): bootstrap/teardown stop touching price monitor (now lazy/shared)"
```

---

## Task 7: Full lint + test

- [ ] **Step 1: Lint the touched files**

```bash
bunx @biomejs/biome check src/workflows src/adapters/persistence/PostgresSetupRepository.ts src/domain/ports/SetupRepository.ts src/config/bootstrapWatch.ts src/config/tearDownWatch.ts
```
Expected: PASS (or only pre-existing format issues).

- [ ] **Step 2: Run all tests**

```bash
bun test
```
Expected: all pass except the known pre-existing flaky `setupWorkflow.integration.test.ts > CONFIRMED happy path`. If new failures appear, investigate before committing.

---

## Task 8: Live verification

Once code is on the working branch, restart the stack from the worktree:

- [ ] **Step 1: Restart docker stack**

```bash
docker compose --env-file /Users/arthur/Documents/Dev/projects/trading-flow/.env -f docker-compose.yml -f docker-compose-dev.yaml up -d --build
```

- [ ] **Step 2: Terminate stale per-watch price monitors (one-shot migration)**

```bash
docker exec tf-temporal temporal workflow signal --query 'WorkflowType="priceMonitorWorkflow" AND ExecutionStatus="Running"' --name stop --address localhost:7233
```

This sends a `stop` signal to all running `priceMonitorWorkflow` instances. The
old per-watch ones (`price-monitor-btcusdt-1h`, etc.) will exit. The new
per-symbol ones won't exist yet (will spawn lazily on next setup creation).

Verify:
```bash
docker exec tf-temporal temporal workflow list --query 'WorkflowType="priceMonitorWorkflow" AND ExecutionStatus="Running"' --address localhost:7233
```
Expected: empty.

- [ ] **Step 3: Trigger a setup creation (manual)**

If the existing watch (`btcusdt-1h`) creates a setup naturally on the next tick,
wait for it. Otherwise force-tick:
```bash
bun run src/cli/force-tick.ts btcusdt-1h
```

(Check whether the pre-filter conditions allow detector to run — may not yield
a setup. That's OK; the code path is exercised regardless.)

- [ ] **Step 4: Observe Temporal — when a setup is created, verify a single workflow per (symbol, source)**

```bash
docker exec tf-temporal temporal workflow list --query 'WorkflowType="priceMonitorWorkflow" AND ExecutionStatus="Running"' --address localhost:7233
```

Expected after a setup is created on BTCUSDT/binance: exactly 1 row, id `price-monitor-binance-BTCUSDT`.

If you create a second watch on BTCUSDT/binance and that watch also creates a
setup, the count should still be 1 (idempotent spawn).

- [ ] **Step 5: Commit any final cleanup**

If verification revealed a small fix-up (a stray import, a typo), commit it.

---

## Self-review notes (for the implementer)

- **Workflow exit semantics:** The price monitor is now spawned lazily and exits when its alive setup count drops to 0. The 60s idle-poll loop is gone. The workflow can re-spawn moments later if a new setup arrives — that's fine, lazy spawn is cheap.
- **`AlreadyStarted` error matching:** Both call sites (in `setup/activities.ts` and the new `ensurePriceMonitorRunning` activity) use `/already.*started|alreadystarted/i`. The wording varies slightly across `@temporalio/client` versions; the regex covers both forms.
- **Task queue choice:** The price monitor runs on `task_queues.scheduler`, same as before. Activities resolved on the scheduler worker (which has `priceFeeds` wired). No change.
- **Why call `ensurePriceMonitorRunning` from `setup/activities.ts` and not from the setup workflow itself?** Activities can run on any worker that registers them; spawning a workflow from an activity is normal Temporal usage. From a workflow we'd need to use `executeChildWorkflow` (different semantics — child fates linked to parent). We want a sibling, fire-and-forget.
- **`AliveSetupSummary` shape:** Make sure `listAliveBySymbol` returns the exact same fields as `listAliveWithInvalidation` (`id`, `watchId`, `asset`, `direction`, `status`, `invalidationLevel`, `workflowId`). The price monitor consumer reads all these.
