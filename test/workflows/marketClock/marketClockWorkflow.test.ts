import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { Session } from "@domain/services/marketSession";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  marketClockWorkflow,
  marketClockWorkflowId,
} from "@workflows/marketClock/marketClockWorkflow";
import type { Configuration as WebpackConfiguration } from "webpack";

let env: TestWorkflowEnvironment;

const ROOT = path.resolve(__dirname, "../../..");

/**
 * Temporal bundles workflow code with webpack, which doesn't understand
 * tsconfig `paths`. We supply the same alias mapping here so transitive
 * domain imports (e.g. @domain/errors inside marketSession.ts) resolve.
 *
 * IMPORTANT: we must merge — not replace — the existing `resolve.alias` so
 * Temporal's internal `__temporal_custom_payload_converter$: false` entries
 * (which mark those modules as optional/ignored) are preserved.
 */
const webpackConfigHook = (config: WebpackConfiguration): WebpackConfiguration => {
  const existingAlias =
    typeof config.resolve?.alias === "object" && !Array.isArray(config.resolve.alias)
      ? config.resolve.alias
      : {};
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...existingAlias,
        "@domain": path.join(ROOT, "src/domain"),
        "@adapters": path.join(ROOT, "src/adapters"),
        "@workflows": path.join(ROOT, "src/workflows"),
        "@config": path.join(ROOT, "src/config"),
        "@observability": path.join(ROOT, "src/observability"),
      },
    },
  };
};

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

describe("marketClockWorkflow", () => {
  test("workflowId helper builds stable id from session", () => {
    expect(marketClockWorkflowId({ kind: "exchange", id: "NASDAQ" })).toBe("clock-exchange-NASDAQ");
    expect(marketClockWorkflowId({ kind: "forex" })).toBe("clock-forex");
    expect(marketClockWorkflowId({ kind: "always-open" })).toBe("clock-always-open");
  });

  test("terminates immediately when no watches in session", async () => {
    const session: Session = { kind: "exchange", id: "NASDAQ" };
    const taskQueue = "test-clock-empty";
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("../../../src/workflows/marketClock/marketClockWorkflow.ts"),
      bundlerOptions: { webpackConfigHook },
      activities: {
        getNow: async () => new Date("2026-04-29T15:00:00Z"),
        listWatchesInSession: async () => [],
        applyToSchedules: async () => {},
      },
    });
    await worker.runUntil(
      env.client.workflow.execute(marketClockWorkflow, {
        args: [{ session }],
        taskQueue,
        workflowId: "test-clock-empty",
      }),
    );
    // If we reach here without timeout, the workflow returned (terminated cleanly).
    expect(true).toBe(true);
  }, 30_000);

  test("pauses all schedules when market is closed (NASDAQ Saturday)", async () => {
    const session: Session = { kind: "exchange", id: "NASDAQ" };
    const taskQueue = "test-clock-pause";
    const applyCalls: Array<{ ids: string[]; action: string; reason: string }> = [];
    let listCallCount = 0;

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("../../../src/workflows/marketClock/marketClockWorkflow.ts"),
      bundlerOptions: { webpackConfigHook },
      activities: {
        // Saturday in UTC = NASDAQ closed. nextOpenAt = Mon 09:30 ET.
        getNow: async () => new Date("2026-05-02T15:00:00Z"),
        listWatchesInSession: async () => {
          listCallCount++;
          // On second call (after sleep), return empty so workflow terminates.
          return listCallCount === 1 ? [{ id: "watch_aapl" }, { id: "watch_msft" }] : [];
        },
        applyToSchedules: async (input: { ids: string[]; action: string; reason: string }) => {
          applyCalls.push(input);
        },
      },
    });
    await worker.runUntil(
      env.client.workflow.execute(marketClockWorkflow, {
        args: [{ session }],
        taskQueue,
        workflowId: "test-clock-pause",
      }),
    );
    expect(applyCalls.length).toBeGreaterThanOrEqual(1);
    expect(applyCalls[0]?.action).toBe("pause");
    expect(applyCalls[0]?.ids.sort()).toEqual(["tick-watch_aapl", "tick-watch_msft"]);
  }, 60_000);

  test("unpauses all schedules when market is open (NASDAQ Wednesday)", async () => {
    const session: Session = { kind: "exchange", id: "NASDAQ" };
    const taskQueue = "test-clock-unpause";
    const applyCalls: Array<{ ids: string[]; action: string; reason: string }> = [];
    let listCallCount = 0;

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("../../../src/workflows/marketClock/marketClockWorkflow.ts"),
      bundlerOptions: { webpackConfigHook },
      activities: {
        // Wednesday 14:35 UTC = 09:35 ET (winter, NASDAQ open).
        getNow: async () => new Date("2026-04-29T14:35:00Z"),
        listWatchesInSession: async () => {
          listCallCount++;
          return listCallCount === 1 ? [{ id: "watch_aapl" }] : [];
        },
        applyToSchedules: async (input: { ids: string[]; action: string; reason: string }) => {
          applyCalls.push(input);
        },
      },
    });
    await worker.runUntil(
      env.client.workflow.execute(marketClockWorkflow, {
        args: [{ session }],
        taskQueue,
        workflowId: "test-clock-unpause",
      }),
    );
    expect(applyCalls.length).toBeGreaterThanOrEqual(1);
    expect(applyCalls[0]?.action).toBe("unpause");
    expect(applyCalls[0]?.ids).toEqual(["tick-watch_aapl"]);
  }, 60_000);
});
