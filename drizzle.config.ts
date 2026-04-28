import type { Config } from "drizzle-kit";

export default {
  schema: "./src/adapters/persistence/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://trading_flow:changeme@localhost:5432/trading_flow",
  },
  verbose: true,
  strict: true,
} satisfies Config;
