import { describe, expect, test } from "bun:test";
import { TelegramNotifier } from "@adapters/notify/TelegramNotifier";

const liveTestEnabled =
  Boolean(process.env.RUN_LIVE_TELEGRAM) &&
  Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
  Boolean(process.env.TELEGRAM_CHAT_ID);

describe.skipIf(!liveTestEnabled)("TelegramNotifier (live)", () => {
  test("send text message returns messageId", async () => {
    const notifier = new TelegramNotifier({ token: process.env.TELEGRAM_BOT_TOKEN ?? "" });
    const result = await notifier.send({
      chatId: process.env.TELEGRAM_CHAT_ID ?? "",
      text: "[trading-flow test] connection check, ignore",
    });
    expect(result.messageId).toBeGreaterThan(0);
  }, 15_000);
});

describe("TelegramNotifier (offline)", () => {
  test("constructor accepts token without throwing", () => {
    const notifier = new TelegramNotifier({ token: "fake:token" });
    expect(notifier).toBeDefined();
  });

  // Stub grammy's bot.api so we observe the call sequence without hitting
  // the network. `new InputFile(path)` is lazy — it only opens the file when
  // grammy's transport layer reads it, which doesn't happen when we stub.
  function stubBotApi(notifier: TelegramNotifier) {
    const calls: Array<{ method: string; chatId: string; textLen: number; hasCaption: boolean; hasButtons: boolean }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: deliberate test-only override of private field
    (notifier as any).bot.api = {
      sendPhoto: async (chatId: string, _file: unknown, opts?: { caption?: string; reply_markup?: unknown }) => {
        calls.push({
          method: "sendPhoto",
          chatId,
          textLen: opts?.caption?.length ?? 0,
          hasCaption: !!opts?.caption,
          hasButtons: !!opts?.reply_markup,
        });
        return { message_id: 100 };
      },
      sendMessage: async (chatId: string, text: string, opts?: { reply_markup?: unknown }) => {
        calls.push({
          method: "sendMessage",
          chatId,
          textLen: text.length,
          hasCaption: false,
          hasButtons: !!opts?.reply_markup,
        });
        return { message_id: 200 };
      },
    };
    return calls;
  }

  test("sendWithButtons fits in caption when text <= 1024 chars: single sendPhoto with caption + buttons", async () => {
    const notifier = new TelegramNotifier({ token: "fake:token" });
    const calls = stubBotApi(notifier);
    const result = await notifier.sendWithButtons({
      chatId: "42",
      text: "short body",
      images: [{ uri: "file:///tmp/fake.png" }],
      buttons: [[{ text: "❌ Kill", callbackData: "kill:1" }]],
    });
    expect(calls).toEqual([
      { method: "sendPhoto", chatId: "42", textLen: 10, hasCaption: true, hasButtons: true },
    ]);
    expect(result.messageId).toBe(100);
  });

  test("sendWithButtons splits when text > 1024 chars: photo (no caption) + sendMessage (text + buttons)", async () => {
    // Why: Telegram's sendPhoto caps caption at 1024 chars. Long detector
    // reasoning would 400 with `caption is too long`; we split into two
    // calls so the user sees the chart + the full body, no truncation.
    const notifier = new TelegramNotifier({ token: "fake:token" });
    const calls = stubBotApi(notifier);
    const longText = "x".repeat(1500);
    const result = await notifier.sendWithButtons({
      chatId: "42",
      text: longText,
      images: [{ uri: "file:///tmp/fake.png" }],
      buttons: [[{ text: "❌ Kill", callbackData: "kill:1" }]],
    });
    expect(calls).toEqual([
      { method: "sendPhoto", chatId: "42", textLen: 0, hasCaption: false, hasButtons: false },
      { method: "sendMessage", chatId: "42", textLen: 1500, hasCaption: false, hasButtons: true },
    ]);
    // Returned messageId is the follow-up (the message bearing the buttons).
    expect(result.messageId).toBe(200);
  });

  test("send() with single image and long text also splits", async () => {
    const notifier = new TelegramNotifier({ token: "fake:token" });
    const calls = stubBotApi(notifier);
    const longText = "y".repeat(1100);
    const result = await notifier.send({
      chatId: "7",
      text: longText,
      images: [{ uri: "file:///tmp/fake.png" }],
    });
    expect(calls).toEqual([
      { method: "sendPhoto", chatId: "7", textLen: 0, hasCaption: false, hasButtons: false },
      { method: "sendMessage", chatId: "7", textLen: 1100, hasCaption: false, hasButtons: false },
    ]);
    expect(result.messageId).toBe(200);
  });

  test("send() with single image and short text stays a single sendPhoto", async () => {
    const notifier = new TelegramNotifier({ token: "fake:token" });
    const calls = stubBotApi(notifier);
    const result = await notifier.send({
      chatId: "7",
      text: "ok",
      images: [{ uri: "file:///tmp/fake.png" }],
    });
    expect(calls).toEqual([
      { method: "sendPhoto", chatId: "7", textLen: 2, hasCaption: true, hasButtons: false },
    ]);
    expect(result.messageId).toBe(100);
  });
});
