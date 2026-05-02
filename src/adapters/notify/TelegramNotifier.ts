import type {
  NotificationButton,
  NotificationImage,
  Notifier,
} from "@domain/ports/Notifier";
import { Bot, InputFile } from "grammy";
import {
  encodeCallbackData,
  formatLessonProposalMessage,
  type LessonProposalMessageInput,
} from "./lessonProposalFormat";

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
      const path = args.images[0]?.uri.replace(/^file:\/\//, "");
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
      return { messageId: msgs[0]?.message_id };
    }

    const msg = await this.bot.api.sendMessage(args.chatId, args.text, {
      parse_mode: parseMode,
    });
    return { messageId: msg.message_id };
  }

  async sendWithButtons(args: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "HTML";
    images?: NotificationImage[];
    buttons: NotificationButton[][];
  }): Promise<{ messageId: number }> {
    const parseMode = args.parseMode === "Markdown" ? "MarkdownV2" : args.parseMode;
    const reply_markup = {
      inline_keyboard: args.buttons.map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
      ),
    };

    if (args.images?.length === 1) {
      const path = args.images[0]?.uri.replace(/^file:\/\//, "");
      const msg = await this.bot.api.sendPhoto(args.chatId, new InputFile(path), {
        caption: args.text,
        parse_mode: parseMode,
        reply_markup,
      });
      return { messageId: msg.message_id };
    }

    // Telegram does not support inline keyboards on media-groups (sendMediaGroup
    // ignores reply_markup). For multi-image + buttons we fall through to a
    // text-only message with the keyboard — callers should pick at most one
    // image when buttons are required.
    const msg = await this.bot.api.sendMessage(args.chatId, args.text, {
      parse_mode: parseMode,
      reply_markup,
    });
    return { messageId: msg.message_id };
  }

  async sendLessonProposal(
    args: LessonProposalMessageInput & {
      chatId: string;
      lessonId: string;
    },
  ): Promise<{ messageId: number }> {
    const text = formatLessonProposalMessage(args);
    return this.sendWithButtons({
      chatId: args.chatId,
      text,
      parseMode: "Markdown",
      buttons: [
        [
          {
            text: "✅ Approve",
            callbackData: encodeCallbackData({ action: "approve", lessonId: args.lessonId }),
          },
          {
            text: "❌ Reject",
            callbackData: encodeCallbackData({ action: "reject", lessonId: args.lessonId }),
          },
        ],
      ],
    });
  }

  async editLessonMessage(args: {
    chatId: string;
    msgId: number;
    finalState: "approved" | "rejected" | "no_longer_pending";
    atIso?: string;
  }): Promise<void> {
    const label =
      args.finalState === "approved"
        ? `✅ Approved by you on ${args.atIso ?? new Date().toISOString()}`
        : args.finalState === "rejected"
          ? `❌ Rejected by you on ${args.atIso ?? new Date().toISOString()}`
          : "ℹ️ No longer pending";
    await this.bot.api.editMessageText(args.chatId, args.msgId, label, {
      parse_mode: "Markdown",
    });
  }
}
