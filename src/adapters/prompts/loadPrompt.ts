import { join } from "node:path";
import Handlebars from "handlebars";

const cache = new Map<
  string,
  { template: HandlebarsTemplateDelegate; systemPrompt: string; version: string }
>();

const VERSION_REGEX = /\{\{!--[\s\S]*?version:\s*([a-zA-Z0-9_-]+)[\s\S]*?--\}\}/;

// Register an `eq` helper for use in templates: {{#if (eq a b)}}…{{/if}}.
// Idempotent: safe to call multiple times — Handlebars overwrites silently.
Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);

export type LoadedPrompt = {
  systemPrompt: string;
  render: (context: unknown) => string;
  version: string;
};

export async function loadPrompt(
  name: "detector" | "reviewer" | "finalizer" | "feedback",
): Promise<LoadedPrompt> {
  const cached = cache.get(name);
  if (cached) {
    return {
      systemPrompt: cached.systemPrompt,
      render: cached.template,
      version: cached.version,
    };
  }

  // Resolve from project root (works in dev + Docker since prompts/ is at /app/prompts in container)
  const userPath = join(process.cwd(), "prompts", `${name}.md.hbs`);
  const systemPath = join(process.cwd(), "prompts", `${name}.system.md`);

  const [userSource, systemSource] = await Promise.all([
    Bun.file(userPath).text(),
    Bun.file(systemPath).text(),
  ]);

  const versionMatch = userSource.match(VERSION_REGEX);
  const version = versionMatch?.[1] ?? `${name}_unknown`;
  const template = Handlebars.compile(userSource);
  const systemPrompt = systemSource.trim();

  cache.set(name, { template, systemPrompt, version });

  return { systemPrompt, render: template, version };
}

export function clearPromptCache(): void {
  cache.clear();
}
