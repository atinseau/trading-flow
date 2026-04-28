import { type WatchesConfig, WatchesConfigSchema } from "@domain/schemas/WatchesConfig";

export class WatchesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchesConfigError";
  }
}

export async function loadWatchesConfig(path: string): Promise<WatchesConfig | null> {
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

  const result = WatchesConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new WatchesConfigError(`Invalid watches config in ${path}:\n${issues}`);
  }
  return result.data;
}
