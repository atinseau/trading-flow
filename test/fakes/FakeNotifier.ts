import type {
  NotificationButton,
  NotificationImage,
  Notifier,
} from "@domain/ports/Notifier";

export class FakeNotifier implements Notifier {
  sentMessages: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "HTML";
    images?: NotificationImage[];
    buttons?: NotificationButton[][];
  }[] = [];
  private nextId = 1;

  async send(args: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "HTML";
    images?: NotificationImage[];
  }): Promise<{ messageId: number }> {
    this.sentMessages.push({
      chatId: args.chatId,
      text: args.text,
      parseMode: args.parseMode,
      images: args.images,
    });
    return { messageId: this.nextId++ };
  }

  async sendWithButtons(args: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "HTML";
    images?: NotificationImage[];
    buttons: NotificationButton[][];
  }): Promise<{ messageId: number }> {
    this.sentMessages.push({
      chatId: args.chatId,
      text: args.text,
      parseMode: args.parseMode,
      images: args.images,
      buttons: args.buttons,
    });
    return { messageId: this.nextId++ };
  }

  reset(): void {
    this.sentMessages = [];
    this.nextId = 1;
  }
}
