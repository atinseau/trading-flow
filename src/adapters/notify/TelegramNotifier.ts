import type { NotificationImage, Notifier } from "@domain/ports/Notifier";
import { Bot, InputFile } from "grammy";

export class TelegramNotifier implements Notifier {
  private bot: Bot;

  constructor(config: { token: string }) {
    this.bot = new Bot(config.token);
  }

  async send(args: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "HTML";
    images?: NotificationImage[];
  }): Promise<{ messageId: number }> {
    const parseMode = args.parseMode === "Markdown" ? "MarkdownV2" : args.parseMode;

    if (args.images?.length === 1) {
      const path = args.images[0]!.uri.replace(/^file:\/\//, "");
      const msg = await this.bot.api.sendPhoto(args.chatId, new InputFile(path), {
        caption: args.text,
        parse_mode: parseMode,
      });
      return { messageId: msg.message_id };
    }

    if (args.images && args.images.length > 1) {
      const media = args.images.map((img) => ({
        type: "photo" as const,
        media: new InputFile(img.uri.replace(/^file:\/\//, "")),
        caption: img.caption,
      }));
      const msgs = await this.bot.api.sendMediaGroup(args.chatId, media);
      return { messageId: msgs[0]!.message_id };
    }

    const msg = await this.bot.api.sendMessage(args.chatId, args.text, {
      parse_mode: parseMode,
    });
    return { messageId: msg.message_id };
  }
}
