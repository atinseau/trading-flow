import { expect, test } from "bun:test";
import { buildProviderRegistry } from "@adapters/llm/buildProviderRegistry";
import type { InfraConfig } from "@config/InfraConfig";
import { CircularFallbackError } from "@domain/errors";
import type { WatchesConfig } from "@domain/schemas/WatchesConfig";

const infraStub: InfraConfig = {
  database: { url: "x", pool_size: 1, ssl: false },
  temporal: {
    address: "x",
    namespace: "default",
    task_queues: { scheduler: "s", analysis: "a", notifications: "n" },
  },
  notifications: { telegram: { bot_token: "t", chat_id: "c" } },
  llm: { openrouter_api_key: "k" },
  artifacts: { base_dir: "/tmp" },
  claude: { workspace_dir: "/tmp" },
};

test("builds registry with claude_max + openrouter, fallback wired", () => {
  const watches = {
    version: 1,
    llm_providers: {
      claude_max: {
        type: "claude-agent-sdk",
        fallback: "openrouter",
      },
      openrouter: {
        type: "openrouter",
        base_url: "https://x",
        fallback: null,
      },
    },
  } as unknown as WatchesConfig;
  const registry = buildProviderRegistry(watches, infraStub);
  expect(registry.get("claude_max")?.fallback).toBe("openrouter");
  expect(registry.get("openrouter")?.fallback).toBeNull();
});

test("circular fallback throws at registry build", () => {
  const watches = {
    version: 1,
    llm_providers: {
      a: { type: "claude-agent-sdk", fallback: "b" },
      b: { type: "claude-agent-sdk", fallback: "a" },
    },
  } as unknown as WatchesConfig;
  expect(() => buildProviderRegistry(watches, infraStub)).toThrow(CircularFallbackError);
});

test("openrouter without api_key throws clear error", () => {
  const infraNoKey: InfraConfig = { ...infraStub, llm: { openrouter_api_key: null } };
  const watches = {
    version: 1,
    llm_providers: {
      openrouter: { type: "openrouter", base_url: "https://x", fallback: null },
    },
  } as unknown as WatchesConfig;
  expect(() => buildProviderRegistry(watches, infraNoKey)).toThrow(/OPENROUTER_API_KEY/);
});
