import { expect, test } from "bun:test";
import { ConsoleNotifier } from "@adapters/notify/ConsoleNotifier";

test("ConsoleNotifier.send logs and returns synthetic messageId", async () => {
  const notifier = new ConsoleNotifier();
  const result = await notifier.send({ chatId: "test-chat", text: "hello" });
  expect(typeof result.messageId).toBe("number");
});

test("ConsoleNotifier.send accepts optional parseMode and images without throwing", async () => {
  const notifier = new ConsoleNotifier();
  const result = await notifier.send({
    chatId: "test-chat",
    text: "hi",
    parseMode: "Markdown",
    images: [{ uri: "/tmp/x.png", caption: "chart" }],
  });
  expect(result).toBeDefined();
});
