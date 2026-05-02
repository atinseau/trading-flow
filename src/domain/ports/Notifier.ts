export type NotificationImage = { uri: string; caption?: string };

export type NotificationButton = { text: string; callbackData: string };

export interface Notifier {
  send(args: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    images?: NotificationImage[];
  }): Promise<{ messageId: number }>;

  /**
   * Variant of `send` that attaches an inline keyboard. `buttons` is a 2D
   * array (rows of buttons). When `images` has exactly one entry the message
   * is sent as a photo with caption + keyboard; otherwise the keyboard is
   * attached to a plain text message (Telegram does not support keyboards
   * on media-groups, so multi-image + keyboard is intentionally unsupported).
   */
  sendWithButtons(args: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    images?: NotificationImage[];
    buttons: NotificationButton[][];
  }): Promise<{ messageId: number }>;
}
