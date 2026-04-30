import { expect, test } from "bun:test";
import { buildProviderRegistry } from "@adapters/llm/buildProviderRegistry";
import type { InfraConfig } from "@config/InfraConfig";

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

test("builds registry with claude_max + openrouter from hardcoded catalog", () => {
  const registry = buildProviderRegistry(infraStub);
  expect(registry.size).toBe(2);
  expect(registry.get("claude_max")?.fallback).toBe("openrouter");
  expect(registry.get("openrouter")?.fallback).toBeNull();
});

test("skips openrouter when api_key is null, severs claude_max fallback", () => {
  const infraNoKey: InfraConfig = { ...infraStub, llm: { openrouter_api_key: null } };
  const registry = buildProviderRegistry(infraNoKey);
  expect(registry.size).toBe(1);
  expect(registry.has("openrouter")).toBe(false);
  // claude_max's fallback would dangle to a missing provider; sever it
  expect(registry.get("claude_max")?.fallback).toBeNull();
});
