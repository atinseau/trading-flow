import { TelegramNotifier } from "@adapters/notify/TelegramNotifier";
import { describe, expect, test } from "bun:test";

class FakeBot {
  api = {
    sendMessage: async (_chatId: string, text: string, opts: unknown) => {
      this.lastSendMessage = { text, opts };
      return { message_id: 42 };
    },
    editMessageText: async (_chatId: string, msgId: number, text: string, _opts: unknown) => {
      this.lastEdit = { msgId, text };
      return { message_id: msgId };
    },
  };
  lastSendMessage: { text: string; opts: unknown } | null = null;
  lastEdit: { msgId: number; text: string } | null = null;
}

describe("TelegramNotifier.sendLessonProposal", () => {
  test("sends with inline keyboard and returns msgId", async () => {
    const bot = new FakeBot();
    const notifier = new TelegramNotifier({ token: "x" });
    // @ts-expect-error inject fake bot for test
    notifier.bot = bot;
    const r = await notifier.sendLessonProposal({
      chatId: "1",
      lessonId: "11111111-1111-1111-1111-111111111111",
      kind: "CREATE",
      watchId: "btc-1h",
      category: "reviewing",
      title: "x".repeat(20),
      body: "y".repeat(60),
      rationale: "z".repeat(30),
      triggerSetupId: "22222222-2222-2222-2222-222222222222",
      triggerCloseReason: "sl_hit_direct",
    });
    expect(r.messageId).toBe(42);
    expect(bot.lastSendMessage?.opts).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            { text: expect.any(String), callback_data: expect.stringContaining("v1|a|") },
            { text: expect.any(String), callback_data: expect.stringContaining("v1|r|") },
          ],
        ],
      },
    });
  });
});

describe("TelegramNotifier.editLessonMessage", () => {
  test("edits the message text in place", async () => {
    const bot = new FakeBot();
    const notifier = new TelegramNotifier({ token: "x" });
    // @ts-expect-error inject fake bot
    notifier.bot = bot;
    await notifier.editLessonMessage({
      chatId: "1",
      msgId: 42,
      finalState: "approved",
      atIso: "2026-04-29T10:00:00Z",
    });
    expect(bot.lastEdit?.msgId).toBe(42);
    expect(bot.lastEdit?.text).toContain("Approved");
  });
});
