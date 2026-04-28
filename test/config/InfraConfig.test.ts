import { afterEach, beforeEach, expect, test } from "bun:test";
import { InfraConfigError, loadInfraConfig } from "@config/InfraConfig";

const VARS = [
  "DATABASE_URL",
  "DATABASE_POOL_SIZE",
  "DATABASE_SSL",
  "TEMPORAL_ADDRESS",
  "TEMPORAL_NAMESPACE",
  "TEMPORAL_TASK_QUEUE_SCHEDULER",
  "TEMPORAL_TASK_QUEUE_ANALYSIS",
  "TEMPORAL_TASK_QUEUE_NOTIFICATIONS",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "OPENROUTER_API_KEY",
  "ARTIFACTS_BASE_DIR",
  "CLAUDE_WORKSPACE_DIR",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

function setRequired() {
  process.env.DATABASE_URL = "postgres://user:pass@host:5432/db";
  process.env.TEMPORAL_ADDRESS = "temporal:7233";
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.TELEGRAM_CHAT_ID = "12345";
}

test("loadInfraConfig throws when DATABASE_URL is missing", () => {
  process.env.TEMPORAL_ADDRESS = "x";
  process.env.TELEGRAM_BOT_TOKEN = "x";
  process.env.TELEGRAM_CHAT_ID = "x";
  expect(() => loadInfraConfig()).toThrow(InfraConfigError);
  expect(() => loadInfraConfig()).toThrow(/DATABASE_URL/);
});

test("loadInfraConfig throws when TELEGRAM_CHAT_ID is missing", () => {
  process.env.DATABASE_URL = "x";
  process.env.TEMPORAL_ADDRESS = "x";
  process.env.TELEGRAM_BOT_TOKEN = "x";
  expect(() => loadInfraConfig()).toThrow(/TELEGRAM_CHAT_ID/);
});

test("loadInfraConfig applies defaults when only required vars are set", () => {
  setRequired();
  const cfg = loadInfraConfig();
  expect(cfg.database.url).toBe("postgres://user:pass@host:5432/db");
  expect(cfg.database.pool_size).toBe(10);
  expect(cfg.database.ssl).toBe(false);
  expect(cfg.temporal.address).toBe("temporal:7233");
  expect(cfg.temporal.namespace).toBe("default");
  expect(cfg.temporal.task_queues.scheduler).toBe("scheduler");
  expect(cfg.temporal.task_queues.analysis).toBe("analysis");
  expect(cfg.temporal.task_queues.notifications).toBe("notifications");
  expect(cfg.notifications.telegram.bot_token).toBe("bot-token");
  expect(cfg.notifications.telegram.chat_id).toBe("12345");
  expect(cfg.llm.openrouter_api_key).toBeNull();
  expect(cfg.artifacts.base_dir).toBe("/data/artifacts");
  expect(cfg.claude.workspace_dir).toBe("/data/claude-workspace");
});

test("loadInfraConfig parses DATABASE_POOL_SIZE as number and DATABASE_SSL as boolean", () => {
  setRequired();
  process.env.DATABASE_POOL_SIZE = "25";
  process.env.DATABASE_SSL = "true";
  const cfg = loadInfraConfig();
  expect(cfg.database.pool_size).toBe(25);
  expect(cfg.database.ssl).toBe(true);
});

test("loadInfraConfig throws on non-numeric DATABASE_POOL_SIZE", () => {
  setRequired();
  process.env.DATABASE_POOL_SIZE = "not-a-number";
  expect(() => loadInfraConfig()).toThrow(InfraConfigError);
});

test("loadInfraConfig accepts overrides for all optional vars", () => {
  setRequired();
  process.env.TEMPORAL_NAMESPACE = "trading";
  process.env.TEMPORAL_TASK_QUEUE_SCHEDULER = "sched-q";
  process.env.OPENROUTER_API_KEY = "or-key";
  process.env.ARTIFACTS_BASE_DIR = "/var/data/artifacts";
  process.env.CLAUDE_WORKSPACE_DIR = "/var/claude";
  const cfg = loadInfraConfig();
  expect(cfg.temporal.namespace).toBe("trading");
  expect(cfg.temporal.task_queues.scheduler).toBe("sched-q");
  expect(cfg.llm.openrouter_api_key).toBe("or-key");
  expect(cfg.artifacts.base_dir).toBe("/var/data/artifacts");
  expect(cfg.claude.workspace_dir).toBe("/var/claude");
});
