import { seedWatchesFromYaml } from "@cli/seedWatchesFromYaml.lib";
import { getLogger } from "@observability/logger";
import pg from "pg";

const log = getLogger({ component: "seed-watches-from-yaml" });

const path = process.argv[2] ?? "config/watches.yaml";
const url = process.env.DATABASE_URL;
if (!url) {
  log.error("DATABASE_URL not set");
  process.exit(1);
}

const yamlText = await Bun.file(path).text();
const pool = new pg.Pool({ connectionString: url });

try {
  const inserted = await seedWatchesFromYaml({ pool, yamlText });
  log.info({ inserted, path }, "seed complete");
} finally {
  await pool.end();
}
process.exit(0);
