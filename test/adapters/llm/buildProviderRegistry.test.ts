import { expect, test } from "bun:test";
import { buildProviderRegistry } from "@adapters/llm/buildProviderRegistry";
import { CircularFallbackError } from "@domain/errors";
import type { Config } from "@domain/schemas/Config";

test("builds registry with claude_max + openrouter, fallback wired", () => {
  const cfg = {
    version: 1,
    llm_providers: {
      claude_max: {
        type: "claude-agent-sdk",
        workspace_dir: "/tmp",
        fallback: "openrouter",
      },
      openrouter: {
        type: "openrouter",
        api_key: "k",
        base_url: "https://x",
        fallback: null,
      },
    },
  } as unknown as Config;
  const registry = buildProviderRegistry(cfg);
  expect(registry.get("claude_max")?.fallback).toBe("openrouter");
  expect(registry.get("openrouter")?.fallback).toBeNull();
});

test("circular fallback throws at registry build", () => {
  const cfg = {
    version: 1,
    llm_providers: {
      a: { type: "claude-agent-sdk", workspace_dir: "/tmp", fallback: "b" },
      b: { type: "claude-agent-sdk", workspace_dir: "/tmp", fallback: "a" },
    },
  } as unknown as Config;
  expect(() => buildProviderRegistry(cfg)).toThrow(CircularFallbackError);
});
