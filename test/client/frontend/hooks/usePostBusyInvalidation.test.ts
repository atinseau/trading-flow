import { ensureHappyDom } from "../setup";

ensureHappyDom();

import { describe, expect, test } from "bun:test";
import { usePostBusyInvalidation } from "@client/hooks/usePostBusyInvalidation";
import { act, renderHook } from "@testing-library/react";

/**
 * The hook's only job is "detect the busy→idle edge and fire `onTransition`
 * once, `delayMs` later". The truth table :
 *
 *  - initial render (undefined → false)   → no fire
 *  - busy → idle (true → false)           → fire after delayMs
 *  - idle → busy (false → true)           → no fire
 *  - busy stays busy (true → true)        → no fire
 *  - rapid bounce (true → false → true)   → cancel the scheduled fire
 */

function makeOnTransition() {
  let count = 0;
  const fn = () => {
    count += 1;
  };
  return {
    fn,
    get count() {
      return count;
    },
  };
}

describe("usePostBusyInvalidation", () => {
  test("initial render to false does NOT fire", async () => {
    const t = makeOnTransition();
    renderHook(({ busy }) => usePostBusyInvalidation(busy, t.fn, 5), {
      initialProps: { busy: false },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.count).toBe(0);
  });

  test("busy → idle fires onTransition once after delay", async () => {
    const t = makeOnTransition();
    const { rerender } = renderHook(({ busy }) => usePostBusyInvalidation(busy, t.fn, 5), {
      initialProps: { busy: true },
    });
    expect(t.count).toBe(0);
    rerender({ busy: false });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(t.count).toBe(1);
  });

  test("idle → busy does NOT fire", async () => {
    const t = makeOnTransition();
    const { rerender } = renderHook(({ busy }) => usePostBusyInvalidation(busy, t.fn, 5), {
      initialProps: { busy: false },
    });
    rerender({ busy: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.count).toBe(0);
  });

  test("rapid bounce (true → false → true) cancels the scheduled fire", async () => {
    const t = makeOnTransition();
    const { rerender } = renderHook(({ busy }) => usePostBusyInvalidation(busy, t.fn, 30), {
      initialProps: { busy: true },
    });
    rerender({ busy: false });
    // Before the timeout fires, bounce back to busy.
    await new Promise((r) => setTimeout(r, 5));
    rerender({ busy: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.count).toBe(0);
  });
});
