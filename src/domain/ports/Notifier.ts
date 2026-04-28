export type NotificationImage = { uri: string; caption?: string };

export interface Notifier {
  send(args: {
    chatId: string;
    text: string;
    parseMode?: "Markdown" | "HTML";
    images?: NotificationImage[];
  }): Promise<{ messageId: number }>;
}
