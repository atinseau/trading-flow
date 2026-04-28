import { readFile } from "node:fs/promises";
import { InvalidConfigError } from "@domain/errors";
import { type Config, ConfigSchema } from "@domain/schemas/Config";

export async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf8");
  const expanded = expandEnvVars(raw);
  const parsed = Bun.YAML.parse(expanded);

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new InvalidConfigError(`Configuration invalide:\n${issues}`);
  }
  return result.data;
}

export function expandEnvVars(input: string): string {
  return input.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new InvalidConfigError(`Variable d'environnement manquante: ${name}`);
    }
    return v;
  });
}
