import { join } from "node:path";
import Handlebars from "handlebars";

const cache = new Map<string, { template: HandlebarsTemplateDelegate; version: string }>();

const VERSION_REGEX = /\{\{!--[\s\S]*?version:\s*([a-zA-Z0-9_-]+)[\s\S]*?--\}\}/;

export async function loadPrompt(
  name: "detector" | "reviewer" | "finalizer",
): Promise<{ render: (context: unknown) => string; version: string }> {
  const cached = cache.get(name);
  if (cached) return { render: cached.template, version: cached.version };

  // Resolve from project root (works in dev + Docker since prompts/ is at /app/prompts in container)
  const path = join(process.cwd(), "prompts", `${name}.md.hbs`);
  const source = await Bun.file(path).text();
  const versionMatch = source.match(VERSION_REGEX);
  const version = versionMatch?.[1] ?? `${name}_unknown`;
  const template = Handlebars.compile(source);

  cache.set(name, { template, version });
  return { render: template, version };
}

export function clearPromptCache(): void {
  cache.clear();
}
