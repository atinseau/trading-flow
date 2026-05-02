import type { ActivityDeps } from "@workflows/activityDependencies";

export function buildNotificationActivities(deps: ActivityDeps) {
  return {
    async notifyTelegram(input: {
      chatId: string;
      text: string;
      images?: { uri: string; caption?: string }[];
      parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    }): Promise<{ messageId: number }> {
      return deps.notifier.send(input);
    },
  };
}
