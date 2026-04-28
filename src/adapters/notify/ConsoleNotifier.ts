import type { Notifier } from "@domain/ports/Notifier";
import { getLogger } from "@observability/logger";

const log = getLogger({ component: "console-notifier" });

export class ConsoleNotifier implements Notifier {
  async send(args: Parameters<Notifier["send"]>[0]): Promise<{ messageId: number }> {
    log.info(
      {
        chatId: args.chatId,
        text: args.text,
        parseMode: args.parseMode,
        images: args.images?.map((i) => ({ uri: i.uri, caption: i.caption })),
      },
      "notification",
    );
    return { messageId: 0 };
  }
}
