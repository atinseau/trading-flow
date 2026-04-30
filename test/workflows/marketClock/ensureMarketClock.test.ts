import { describe, expect, test } from "bun:test";
import type { WatchRepository } from "@domain/ports/WatchRepository";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { WorkflowNotFoundError } from "@temporalio/client";
import { bootstrapMarketClocks, ensureMarketClock } from "@workflows/marketClock/ensureMarketClock";

function makeFakeClient(
  opts: {
    describeImpl?: (id: string) => Promise<{ status: { name: string } }>;
    startImpl?: (workflowId: string) => Promise<void>;
  } = {},
) {
  const startCalls: string[] = [];
  const client = {
    workflow: {
      getHandle: (id: string) => ({
        describe: () =>
          opts.describeImpl
            ? opts.describeImpl(id)
            : Promise.reject(new WorkflowNotFoundError("not found", id, "default")),
      }),
      start: async (_wf: unknown, options: { workflowId: string }) => {
        startCalls.push(options.workflowId);
        if (opts.startImpl) await opts.startImpl(options.workflowId);
        // biome-ignore lint/suspicious/noExplicitAny: minimal Handle for tests
        return {} as any;
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Client
  } as any;
  return { client, startCalls };
}

const fakeWatchRepo = (watches: WatchConfig[]): WatchRepository => ({
  findAll: async () => watches,
  findById: async (id) => watches.find((w) => w.id === id) ?? null,
  findEnabled: async () => watches.filter((w) => w.enabled),
  findAllWithValidation: async () => [],
});

const watchOf = (id: string, asset: object, enabled = true): WatchConfig =>
  ({ id, enabled, asset }) as WatchConfig;

describe("ensureMarketClock", () => {
  test("skips always-open sessions (no workflow start)", async () => {
    const { client, startCalls } = makeFakeClient();
    await ensureMarketClock({
      client,
      taskQueue: "scheduler",
      session: { kind: "always-open" },
    });
    expect(startCalls).toEqual([]);
  });

  test("starts a workflow when none is running for the session", async () => {
    const { client, startCalls } = makeFakeClient();
    await ensureMarketClock({
      client,
      taskQueue: "scheduler",
      session: { kind: "exchange", id: "NASDAQ" },
    });
    expect(startCalls).toEqual(["clock-exchange-NASDAQ"]);
  });

  test("no-op when workflow already RUNNING", async () => {
    const { client, startCalls } = makeFakeClient({
      describeImpl: async () => ({ status: { name: "RUNNING" } }),
    });
    await ensureMarketClock({
      client,
      taskQueue: "scheduler",
      session: { kind: "exchange", id: "NASDAQ" },
    });
    expect(startCalls).toEqual([]);
  });

  test("restarts when a previous workflow run COMPLETED", async () => {
    const { client, startCalls } = makeFakeClient({
      describeImpl: async () => ({ status: { name: "COMPLETED" } }),
    });
    await ensureMarketClock({
      client,
      taskQueue: "scheduler",
      session: { kind: "forex" },
    });
    expect(startCalls).toEqual(["clock-forex"]);
  });

  test("swallows ALREADY_RUNNING race (concurrent ensureMarketClock callers)", async () => {
    const { client, startCalls } = makeFakeClient({
      startImpl: async () => {
        throw new Error("workflow already running");
      },
    });
    await expect(
      ensureMarketClock({
        client,
        taskQueue: "scheduler",
        session: { kind: "exchange", id: "NASDAQ" },
      }),
    ).resolves.toBeUndefined();
    expect(startCalls).toEqual(["clock-exchange-NASDAQ"]);
  });
});

describe("bootstrapMarketClocks", () => {
  test("starts one clock per distinct non-always-open session", async () => {
    const { client, startCalls } = makeFakeClient();
    const watches = [
      watchOf("aapl", {
        source: "yahoo",
        symbol: "AAPL",
        quoteType: "EQUITY",
        exchange: "NMS",
      }),
      watchOf("msft", {
        source: "yahoo",
        symbol: "MSFT",
        quoteType: "EQUITY",
        exchange: "NMS",
      }),
      watchOf("cac", {
        source: "yahoo",
        symbol: "^FCHI",
        quoteType: "INDEX",
        exchange: "PAR",
      }),
      watchOf("eurusd", {
        source: "yahoo",
        symbol: "EURUSD=X",
        quoteType: "CURRENCY",
      }),
      watchOf("btc", { source: "binance", symbol: "BTCUSDT" }),
    ];
    await bootstrapMarketClocks({
      client,
      taskQueue: "scheduler",
      watches: fakeWatchRepo(watches),
    });
    expect(startCalls.sort()).toEqual([
      "clock-exchange-NASDAQ",
      "clock-exchange-PAR",
      "clock-forex",
    ]);
  });

  test("skips disabled watches", async () => {
    const { client, startCalls } = makeFakeClient();
    const watches = [
      watchOf(
        "aapl",
        {
          source: "yahoo",
          symbol: "AAPL",
          quoteType: "EQUITY",
          exchange: "NMS",
        },
        false,
      ),
    ];
    await bootstrapMarketClocks({
      client,
      taskQueue: "scheduler",
      watches: fakeWatchRepo(watches),
    });
    expect(startCalls).toEqual([]);
  });

  test("skips watches with invalid sessions (unknown exchange)", async () => {
    const { client, startCalls } = makeFakeClient();
    const watches = [
      watchOf("good", {
        source: "yahoo",
        symbol: "AAPL",
        quoteType: "EQUITY",
        exchange: "NMS",
      }),
      watchOf("broken", {
        source: "yahoo",
        symbol: "FOO",
        quoteType: "EQUITY",
        exchange: "XYZ",
      }),
    ];
    await bootstrapMarketClocks({
      client,
      taskQueue: "scheduler",
      watches: fakeWatchRepo(watches),
    });
    expect(startCalls).toEqual(["clock-exchange-NASDAQ"]);
  });
});
