import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for tf-web");

export const pool = new pg.Pool({
  connectionString: url,
  max: Number(process.env.TF_WEB_PG_POOL_SIZE ?? 10),
});

export const db = drizzle(pool);
