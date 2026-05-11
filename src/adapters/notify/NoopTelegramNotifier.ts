import type { NotificationButton, NotificationImage, Notifier } from "@domain/ports/Notifier";

export type CapturedNotification = {
  kind: "send" | "sendWithButtons";
  chatId: string;
  text: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  images?: NotificationImage[];
  buttons?: NotificationButton[][];
  /** Monotonically increasing message id, returned to the caller. */
  messageId: number;
  /** Wall-clock time of capture (debug). */
  capturedAt: Date;
};

/**
 * Notifier substitute used in replay sessions. Captures the message that
 * production would have sent and persists it via the `onCapture`
 * callback. NEVER calls the Telegram API.
 *
 * The replay activity wires `onCapture` so the captured text lands in
 * the corresponding `replay_events.payload.telegram_preview` field —
 * the UI then displays it next to the event with a "NEUTRALISÉ" badge.
 *
 * Returns synthetic incremental messageIds (>= 1) so callers that store
 * the id (e.g. for reply tracking) keep a stable referent within the
 * session, while no real Telegram message exists.
 */
export class NoopTelegramNotifier implements Notifier {
  private nextMessageId = 1;
  /** All captured messages in order (debug / inspection). */
  readonly captured: CapturedNotification[] = [];

  constructor(
    private readonly onCapture: (n: CapturedNotification) => Promise<void> | void = () => {},
  ) {}

  async send(args: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    images?: NotificationImage[];
  }): Promise<{ messageId: number }> {
    const messageId = this.nextMessageId++;
    const record: CapturedNotification = {
      kind: "send",
      chatId: args.chatId,
      text: args.text,
      parseMode: args.parseMode,
      images: args.images,
      messageId,
      capturedAt: new Date(),
    };
    this.captured.push(record);
    await this.onCapture(record);
    return { messageId };
  }

  async sendWithButtons(args: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    images?: NotificationImage[];
    buttons: NotificationButton[][];
  }): Promise<{ messageId: number }> {
    const messageId = this.nextMessageId++;
    const record: CapturedNotification = {
      kind: "sendWithButtons",
      chatId: args.chatId,
      text: args.text,
      parseMode: args.parseMode,
      images: args.images,
      buttons: args.buttons,
      messageId,
      capturedAt: new Date(),
    };
    this.captured.push(record);
    await this.onCapture(record);
    return { messageId };
  }
}
