import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { Wait } from "testcontainers";

export type TestPostgres = {
  container: StartedPostgreSqlContainer;
  pool: pg.Pool;
  db: ReturnType<typeof drizzle>;
  cleanup: () => Promise<void>;
};

/**
 * Start an isolated Postgres container with migrations applied.
 * Uses log-message wait strategy because the default port-listen probe
 * hangs under Bun (https://github.com/oven-sh/bun/issues/21342).
 */
export async function startTestPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./migrations" });
  return {
    container,
    pool,
    db,
    cleanup: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
