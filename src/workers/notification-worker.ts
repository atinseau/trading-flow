import { parseCallbackData } from "@adapters/notify/lessonProposalFormat";
import { TelegramNotifier } from "@adapters/notify/TelegramNotifier";
import { loadInfraConfig } from "@config/InfraConfig";
import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { buildLessonApprovalUseCase } from "@domain/feedback/lessonApprovalUseCase";
import { HealthServer } from "@observability/healthServer";
import { getLogger } from "@observability/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildNotificationActivities } from "@workflows/notification/activities";
import { Bot } from "grammy";
import pg from "pg";
import { buildContainer } from "./buildContainer";

const log = getLogger({ component: "notification-worker" });

const infra = loadInfraConfig();

const healthPort = Number(process.env.HEALTH_PORT ?? 8083);
const health = new HealthServer("notification-worker", healthPort);
health.start();

const bootstrapPool = new pg.Pool({
  connectionString: infra.database.url,
  max: 2,
  ssl: infra.database.ssl,
});
const watches = await loadWatchesFromDb(bootstrapPool);
await bootstrapPool.end();

const container = await buildContainer(infra, watches, "notification");
const connection = await NativeConnection.connect({ address: infra.temporal.address });

const worker = await Worker.create({
  connection,
  namespace: infra.temporal.namespace,
  taskQueue: infra.temporal.task_queues.notifications,
  activities: buildNotificationActivities(container.deps),
});

// --- Telegram callback handler (lesson approval) ---
const allowlistedChatId = infra.notifications.telegram.chat_id;
const bot = new Bot(infra.notifications.telegram.bot_token);
{
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

log.info(
  { taskQueue: infra.temporal.task_queues.notifications, watchCount: watches.length },
  "starting",
);

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
