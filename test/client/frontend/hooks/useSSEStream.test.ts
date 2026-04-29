import { ensureHappyDom } from "../setup";

ensureHappyDom();

import { describe, expect, mock, test } from "bun:test";
import { useSSEStream } from "@client/hooks/useSSEStream";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import * as React from "react";

class FakeES {
  static instance: FakeES | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(public url: string) {
    FakeES.instance = this;
  }
  addEventListener(t: string, fn: (e: MessageEvent) => void): void {
    if (!this.listeners.has(t)) this.listeners.set(t, []);
    this.listeners.get(t)!.push(fn);
  }
  fire(topic: string, data: unknown): void {
    const ev = new MessageEvent("message", { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(topic) ?? []) fn(ev);
  }
  close(): void {
    /* no-op */
  }
}

(globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;

const wrap =
  (qc: QueryClient) =>
  ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);

describe("useSSEStream", () => {
  test("invalidates queries on `events` push", async () => {
    const qc = new QueryClient();
    const spy = mock(qc.invalidateQueries.bind(qc));
    qc.invalidateQueries = spy;

    renderHook(() => useSSEStream(), { wrapper: wrap(qc) });

    await act(async () => {
      FakeES.instance?.fire("events", { id: "e1", setupId: "s1", type: "Strengthened" });
    });

    await waitFor(() => {
      expect(spy.mock.calls.some((c) => JSON.stringify(c).includes("setups"))).toBe(true);
    });
  });

  test("appends to ['events','live'] live feed", async () => {
    const qc = new QueryClient();
    renderHook(() => useSSEStream(), { wrapper: wrap(qc) });

    await act(async () => {
      FakeES.instance?.fire("events", { id: "e2", setupId: "s2", type: "X" });
    });

    const live = qc.getQueryData<unknown[]>(["events", "live"]) ?? [];
    expect(live.length).toBeGreaterThan(0);
  });
});
