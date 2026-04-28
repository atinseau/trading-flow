import { z } from "zod";

export class InfraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraConfigError";
  }
}

const InfraConfigSchema = z.object({
  database: z.object({
    url: z.string().min(1),
    pool_size: z.number().int().positive(),
    ssl: z.boolean(),
  }),
  temporal: z.object({
    address: z.string().min(1),
    namespace: z.string().min(1),
    task_queues: z.object({
      scheduler: z.string().min(1),
      analysis: z.string().min(1),
      notifications: z.string().min(1),
    }),
  }),
  notifications: z.object({
    telegram: z.object({
      bot_token: z.string().min(1),
      chat_id: z.string().min(1),
    }),
  }),
  llm: z.object({
    openrouter_api_key: z.string().nullable(),
  }),
  artifacts: z.object({
    base_dir: z.string().min(1),
  }),
  claude: z.object({
    workspace_dir: z.string().min(1),
  }),
});

export type InfraConfig = z.infer<typeof InfraConfigSchema>;

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new InfraConfigError(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function nullable(name: string): string | null {
  const v = process.env[name];
  return v === undefined || v === "" ? null : v;
}

function parseInt10(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new InfraConfigError(
      `Invalid ${name}: expected positive integer, got "${raw}"`,
    );
  }
  return n;
}

function parseBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new InfraConfigError(
    `Invalid ${name}: expected "true"|"false"|"1"|"0", got "${raw}"`,
  );
}

export function loadInfraConfig(): InfraConfig {
  const raw = {
    database: {
      url: required("DATABASE_URL"),
      pool_size: parseInt10("DATABASE_POOL_SIZE", 10),
      ssl: parseBool("DATABASE_SSL", false),
    },
    temporal: {
      address: required("TEMPORAL_ADDRESS"),
      namespace: optional("TEMPORAL_NAMESPACE", "default"),
      task_queues: {
        scheduler: optional("TEMPORAL_TASK_QUEUE_SCHEDULER", "scheduler"),
        analysis: optional("TEMPORAL_TASK_QUEUE_ANALYSIS", "analysis"),
        notifications: optional("TEMPORAL_TASK_QUEUE_NOTIFICATIONS", "notifications"),
      },
    },
    notifications: {
      telegram: {
        bot_token: required("TELEGRAM_BOT_TOKEN"),
        chat_id: required("TELEGRAM_CHAT_ID"),
      },
    },
    llm: {
      openrouter_api_key: nullable("OPENROUTER_API_KEY"),
    },
    artifacts: {
      base_dir: optional("ARTIFACTS_BASE_DIR", "/data/artifacts"),
    },
    claude: {
      workspace_dir: optional("CLAUDE_WORKSPACE_DIR", "/data/claude-workspace"),
    },
  };

  const result = InfraConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new InfraConfigError(`InfraConfig validation failed:\n${issues}`);
  }
  return result.data;
}
