import { describe, expect, test } from "bun:test";
import { ClaudeAgentSdkProvider } from "@adapters/llm/ClaudeAgentSdkProvider";

describe("ClaudeAgentSdkProvider", () => {
  test("isAvailable returns false when daily budget exceeded", async () => {
    const provider = new ClaudeAgentSdkProvider("claude_max", {
      workspaceDir: "/tmp",
      dailyCallBudget: 0,
    });
    expect(await provider.isAvailable()).toBe(false);
  });

  test("isAvailable returns true with remaining budget", async () => {
    const provider = new ClaudeAgentSdkProvider("claude_max", {
      workspaceDir: "/tmp",
      dailyCallBudget: 100,
    });
    expect(await provider.isAvailable()).toBe(true);
  });

  test("name and fallback exposed correctly", () => {
    const provider = new ClaudeAgentSdkProvider("claude_max", {
      workspaceDir: "/tmp",
      fallback: "openrouter",
    });
    expect(provider.name).toBe("claude_max");
    expect(provider.fallback).toBe("openrouter");
  });
});
