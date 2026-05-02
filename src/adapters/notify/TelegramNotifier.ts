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

// Telegram caps `sendPhoto` captions at 1024 characters. The detector
// can emit reasoning longer than that, so when we have a single image and
// a long body we split into two API calls: photo first (no caption), then
// `sendMessage` with the full text + any buttons. Zero content loss; the
// returned messageId points to the message bearing the buttons (the one
// callers track for edit/reply flows).
const PHOTO_CAPTION_LIMIT = 1024;

export class TelegramNotifier implements Notifier {
  private bot: Bot;

  constructor(config: { token: string }) {
    this.bot = new Bot(config.token);
  }

  /**
   * Send a single photo + body, splitting into two messages when the body
   * exceeds Telegram's caption limit. Returns the messageId of whichever
   * message carries the body (and any inline keyboard).
   */
  private async sendPhotoOrSplit(args: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    imageUri: string;
    reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
  }): Promise<{ messageId: number }> {
    const path = args.imageUri.replace(/^file:\/\//, "");
    if (args.text.length <= PHOTO_CAPTION_LIMIT) {
      const msg = await this.bot.api.sendPhoto(args.chatId, new InputFile(path), {
        caption: args.text,
        parse_mode: args.parseMode,
        reply_markup: args.reply_markup,
      });
      return { messageId: msg.message_id };
    }
    await this.bot.api.sendPhoto(args.chatId, new InputFile(path));
    const followup = await this.bot.api.sendMessage(args.chatId, args.text, {
      parse_mode: args.parseMode,
      reply_markup: args.reply_markup,
    });
    return { messageId: followup.message_id };
  }

  async send(args: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    images?: NotificationImage[];
  }): Promise<{ messageId: number }> {
    // No translation — pass through whatever the caller requested. The
    // legacy lesson template uses "Markdown" (v1) which is more permissive
    // than MarkdownV2 about un-escaped punctuation; silently up-converting
    // would cause Telegram's parse-entities check to fail.
    const parseMode = args.parseMode;

    if (args.images?.length === 1) {
      const uri = args.images[0]?.uri;
      if (uri) return this.sendPhotoOrSplit({ chatId: args.chatId, text: args.text, parseMode, imageUri: uri });
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
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    images?: NotificationImage[];
    buttons: NotificationButton[][];
  }): Promise<{ messageId: number }> {
    // No translation — see comment in `send()` above.
    const parseMode = args.parseMode;
    const reply_markup = {
      inline_keyboard: args.buttons.map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
      ),
    };

    if (args.images?.length === 1) {
      const uri = args.images[0]?.uri;
      if (uri)
        return this.sendPhotoOrSplit({
          chatId: args.chatId,
          text: args.text,
          parseMode,
          imageUri: uri,
          reply_markup,
        });
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
