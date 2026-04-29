import { parseCallbackData } from "@adapters/notify/lessonProposalFormat";
import { TelegramNotifier } from "@adapters/notify/TelegramNotifier";
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesConfig } from "@config/loadWatchesConfig";
import { buildLessonApprovalUseCase } from "@domain/feedback/lessonApprovalUseCase";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildNotificationActivities } from "@workflows/notification/activities";
import { Bot } from "grammy";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "notification-worker" });

const configPath = process.argv[2] ?? "config/watches.yaml";
const infra = loadInfraConfig();
const watches = await loadWatchesConfig(configPath);

const healthPort = Number(process.env.HEALTH_PORT ?? 8083);
const health = new HealthServer("notification-worker", healthPort);
health.start();

if (watches === null) {
  const container = await buildContainer(infra, null, "notification");
  health.setStatus("standby", {
    reason: "no watches.yaml — system idle, drop the file and restart",
  });
  log.info({ configPath }, "standby: no watches.yaml — idle (Temporal worker not registered)");
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  log.info("shutting down (standby)");
  await health.stop();
  await container.shutdown();
  process.exit(0);
}

const container = await buildContainer(infra, watches, "notification");
const connection = await NativeConnection.connect({ address: infra.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: infra.temporal.namespace,
  taskQueue: infra.temporal.task_queues.notifications,
  activities: buildNotificationActivities(container.deps),
});

// --- Telegram callback handler (lesson approval) ---
let bot: Bot | null = null;
if (watches.notifications.telegram) {
  const allowlistedChatId = infra.notifications.telegram.chat_id;
  bot = new Bot(infra.notifications.telegram.bot_token);
  const telegramNotifier = new TelegramNotifier({
    token: infra.notifications.telegram.bot_token,
  });
  const { lessonStore, lessonEventStore, clock } = container.deps;

  const lessonApprovalUseCase = buildLessonApprovalUseCase({
    lessonStore,
    lessonEventStore,
    editLessonMessage: async (args) => {
      await telegramNotifier.editLessonMessage(args);
    },
    chatId: allowlistedChatId,
    notificationMsgIdByLessonId: async (lessonId) => {
      const events = await lessonEventStore.listForLesson(lessonId);
      const sent = events.find((e) => e.type === "NotificationSent");
      if (sent && sent.payload.type === "NotificationSent") {
        return sent.payload.data.msgId;
      }
      return null;
    },
    clock,
  });

  bot.on("callback_query:data", async (ctx) => {
    const fromChatId = ctx.chat?.id?.toString();
    if (fromChatId !== allowlistedChatId) {
      log.debug({ chatId: fromChatId }, "ignored callback_query from non-allowlisted chat");
      await ctx.answerCallbackQuery();
      return;
    }
    const parsed = parseCallbackData(ctx.callbackQuery.data ?? "");
    if (!parsed) {
      log.warn({ data: ctx.callbackQuery.data }, "ignored malformed callback_data");
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      await lessonApprovalUseCase.handle({
        action: parsed.action,
        lessonId: parsed.lessonId,
        via: "telegram",
      });
    } catch (err) {
      log.error({ err, lessonId: parsed.lessonId }, "lesson approval handler failed");
    }
    await ctx.answerCallbackQuery();
  });

  // Start polling in background; don't block worker startup.
  bot.start({ drop_pending_updates: true }).catch((err) => {
    log.error({ err }, "telegram bot polling stopped");
  });
  log.info("telegram callback handler registered");
}

log.info({ taskQueue: infra.temporal.task_queues.notifications }, "starting");

const healthTick = setInterval(() => {
  const runState = worker.getState();
  if (runState === "FAILED" || runState === "STOPPED") {
    health.setStatus("down", { workerStatus: runState });
  } else if (runState === "DRAINING" || runState === "DRAINED" || runState === "STOPPING") {
    health.setStatus("degraded", { workerStatus: runState });
  } else {
    health.setStatus("ok", { workerStatus: runState });
  }
  health.setActivity();
}, 5_000);

process.on("SIGTERM", async () => {
  log.info("shutting down");
  clearInterval(healthTick);
  health.setStatus("down");
  await health.stop();
  if (bot) await bot.stop();
  worker.shutdown();
  await container.shutdown();
});
await worker.run();
