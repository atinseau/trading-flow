import { describe, expect, test } from "bun:test";
import { TelegramNotifier } from "@adapters/notify/TelegramNotifier";

const liveTestEnabled =
  Boolean(process.env.TELEGRAM_BOT_TOKEN) && Boolean(process.env.TELEGRAM_CHAT_ID);

describe.skipIf(!liveTestEnabled)("TelegramNotifier (live)", () => {
  test("send text message returns messageId", async () => {
    const notifier = new TelegramNotifier({ token: process.env.TELEGRAM_BOT_TOKEN! });
    const result = await notifier.send({
      chatId: process.env.TELEGRAM_CHAT_ID!,
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
});
