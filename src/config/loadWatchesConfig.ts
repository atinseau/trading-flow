import { loadWatchesFromDb } from "@config/loadWatchesFromDb";
import { type WatchesConfig, WatchesConfigSchema } from "@domain/schemas/WatchesConfig";
import type pg from "pg";

export class WatchesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchesConfigError";
  }
}

export async function loadWatchesConfig(
  path: string,
  opts?: { pool?: pg.Pool },
): Promise<WatchesConfig | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  let raw: string;
  try {
    raw = await file.text();
  } catch (err) {
    throw new WatchesConfigError(`Failed to read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(raw);
  } catch (err) {
    throw new WatchesConfigError(`Malformed YAML in ${path}: ${(err as Error).message}`);
  }

  // When a pool is provided, watches[] is sourced from the DB instead of YAML.
  // The yaml's watches: array is ignored in that case.
  let merged = parsed;
  if (opts?.pool && parsed && typeof parsed === "object") {
    const dbWatches = await loadWatchesFromDb(opts.pool);
    merged = { ...(parsed as Record<string, unknown>), watches: dbWatches };
  }

  const result = WatchesConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new WatchesConfigError(`Invalid watches config in ${path}:\n${issues}`);
  }
  return result.data;
}
