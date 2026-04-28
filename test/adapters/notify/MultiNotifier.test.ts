import { expect, test } from "bun:test";
import { MultiNotifier } from "@adapters/notify/MultiNotifier";
import type { Notifier } from "@domain/ports/Notifier";

function spy(returnId: number) {
  const calls: Array<Parameters<Notifier["send"]>[0]> = [];
  const notifier: Notifier = {
    async send(args) {
      calls.push(args);
      return { messageId: returnId };
    },
  };
  return { notifier, calls };
}

test("MultiNotifier forwards send to every delegate in order", async () => {
  const a = spy(11);
  const b = spy(22);
  const multi = new MultiNotifier([a.notifier, b.notifier]);
  const result = await multi.send({ chatId: "c", text: "hello" });
  expect(a.calls).toHaveLength(1);
  expect(b.calls).toHaveLength(1);
  expect(a.calls[0]).toEqual({ chatId: "c", text: "hello" });
  expect(result.messageId).toBe(11); // first delegate wins
});

test("MultiNotifier with empty delegate list returns synthetic messageId 0", async () => {
  const multi = new MultiNotifier([]);
  const result = await multi.send({ chatId: "c", text: "x" });
  expect(result).toEqual({ messageId: 0 });
});

test("MultiNotifier propagates errors from delegates", async () => {
  const failing: Notifier = {
    async send() {
      throw new Error("boom");
    },
  };
  const multi = new MultiNotifier([failing]);
  await expect(multi.send({ chatId: "c", text: "x" })).rejects.toThrow("boom");
});
