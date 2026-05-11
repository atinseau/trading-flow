import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type CapturedNotification,
  NoopTelegramNotifier,
} from "@adapters/notify/NoopTelegramNotifier";

let fetchCalls: number;
let originalFetch: typeof fetch;

beforeEach(() => {
  // Trap any accidental network call: tests fail if the notifier reaches out.
  fetchCalls = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    fetchCalls += 1;
    throw new Error("NoopTelegramNotifier MUST NOT make HTTP calls");
  }) as unknown as typeof fetch;
});

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

describe("NoopTelegramNotifier", () => {
  test("send() captures the message and returns a synthetic messageId", async () => {
    const notifier = new NoopTelegramNotifier();
    const { messageId } = await notifier.send({
      chatId: "123",
      text: "🟢 Setup confirmed: entry 42 350",
      parseMode: "Markdown",
    });
    expect(messageId).toBeGreaterThan(0);
    expect(notifier.captured.length).toBe(1);
    expect(notifier.captured[0]?.text).toContain("Setup confirmed");
    expect(notifier.captured[0]?.kind).toBe("send");
    restoreFetch();
  });

  test("sendWithButtons() captures buttons + images", async () => {
    const notifier = new NoopTelegramNotifier();
    await notifier.sendWithButtons({
      chatId: "123",
      text: "Approve this lesson?",
      buttons: [[{ text: "✅", callbackData: "approve:L1" }]],
      images: [{ uri: "file:///chart.png" }],
    });
    const r = notifier.captured[0];
    expect(r?.kind).toBe("sendWithButtons");
    expect(r?.buttons?.[0]?.[0]?.callbackData).toBe("approve:L1");
    expect(r?.images?.[0]?.uri).toBe("file:///chart.png");
    restoreFetch();
  });

  test("messageId is monotonically increasing", async () => {
    const notifier = new NoopTelegramNotifier();
    const a = await notifier.send({ chatId: "c", text: "1" });
    const b = await notifier.send({ chatId: "c", text: "2" });
    const c = await notifier.send({ chatId: "c", text: "3" });
    expect(b.messageId).toBeGreaterThan(a.messageId);
    expect(c.messageId).toBeGreaterThan(b.messageId);
    restoreFetch();
  });

  test("onCapture callback is invoked", async () => {
    const calls: CapturedNotification[] = [];
    const notifier = new NoopTelegramNotifier((n) => {
      calls.push(n);
    });
    await notifier.send({ chatId: "c", text: "hello" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.text).toBe("hello");
    restoreFetch();
  });

  test("NEVER calls fetch — verified by trapped global", async () => {
    const notifier = new NoopTelegramNotifier();
    await notifier.send({ chatId: "c", text: "hi" });
    await notifier.sendWithButtons({
      chatId: "c",
      text: "hi",
      buttons: [[{ text: "x", callbackData: "y" }]],
    });
    expect(fetchCalls).toBe(0);
    restoreFetch();
  });
});
