import type { WatchRepository, WatchValidationResult } from "@domain/ports/WatchRepository";
import { type WatchConfig, WatchSchema } from "@domain/schemas/WatchesConfig";
import { and, eq, isNull } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { watchConfigs } from "./schema";

type DB = ReturnType<typeof drizzle>;

export class PostgresWatchRepository implements WatchRepository {
  constructor(private db: DB) {}

  async findAll(): Promise<WatchConfig[]> {
    const all = await this.findAllWithValidation();
    const valid: WatchConfig[] = [];
    for (const r of all) {
      if (r.watch) valid.push(r.watch);
    }
    return valid;
  }

  async findById(id: string): Promise<WatchConfig | null> {
    const rows = await this.db
      .select()
      .from(watchConfigs)
      .where(and(eq(watchConfigs.id, id), isNull(watchConfigs.deletedAt)))
      .limit(1);
    if (!rows[0]) return null;
    const parsed = WatchSchema.safeParse(rows[0].config);
    return parsed.success ? parsed.data : null;
  }

  async findEnabled(): Promise<WatchConfig[]> {
    const all = await this.findAllWithValidation();
    const enabled: WatchConfig[] = [];
    for (const r of all) {
      if (r.watch?.enabled) enabled.push(r.watch);
    }
    return enabled;
  }

  async findAllWithValidation(): Promise<WatchValidationResult[]> {
    const rows = await this.db.select().from(watchConfigs).where(isNull(watchConfigs.deletedAt));
    return rows.map((row) => {
      const parsed = WatchSchema.safeParse(row.config);
      if (parsed.success) {
        return { id: row.id, raw: row.config, watch: parsed.data };
      }
      const error = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return { id: row.id, raw: row.config, error };
    });
  }
}
