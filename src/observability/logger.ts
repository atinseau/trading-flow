import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    env: process.env.NODE_ENV ?? "development",
    service: "trading-flow",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l" },
        },
      }
    : {}),
});

/**
 * Create a child logger with bound context fields.
 * Use sparingly — bound fields appear on EVERY log line from this logger.
 *
 * @example
 *   const log = getLogger({ component: "scheduler-worker", watchId: "btc-1h" });
 *   log.info({ event: "tick_started" }, "Starting tick");
 */
export function getLogger(context: Record<string, unknown>): pino.Logger {
  return rootLogger.child(context);
}
