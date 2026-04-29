import { watchConfigs, watchConfigRevisions } from "@adapters/persistence/schema";
import { WatchSchema } from "@domain/schemas/WatchesConfig";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";

export async function seedWatchesFromYaml(input: {
  pool: pg.Pool;
  yamlText: string;
}): Promise<number> {
  const db = drizzle(input.pool);
  const parsed = Bun.YAML.parse(input.yamlText) as { watches?: unknown[] };
  const watchesRaw = parsed?.watches ?? [];

  let inserted = 0;
  for (const raw of watchesRaw) {
    const watch = WatchSchema.parse(raw);
    const [existing] = await db.select().from(watchConfigs).where(eq(watchConfigs.id, watch.id));
    if (existing) continue;

    await db.transaction(async (tx) => {
      await tx.insert(watchConfigs).values({
        id: watch.id,
        enabled: watch.enabled,
        config: watch as unknown,
        version: 1,
      });
      await tx.insert(watchConfigRevisions).values({
        watchId: watch.id,
        config: watch as unknown,
        version: 1,
        appliedBy: "seed",
      });
    });
    inserted += 1;
  }
  return inserted;
}
