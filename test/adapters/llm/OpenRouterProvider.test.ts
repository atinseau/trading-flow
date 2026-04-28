import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenRouterProvider } from "@adapters/llm/OpenRouterProvider";
import { LLMRateLimitError } from "@domain/errors";
import { InMemoryLLMUsageStore } from "@test-fakes/InMemoryLLMUsageStore";
import { z } from "zod";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/chat/completions") {
        const auth = req.headers.get("authorization");
        if (auth !== "Bearer test-key") return new Response("unauth", { status: 401 });
        const body = (await req.json()) as { model: string };
        if (body.model === "rate-limit-test") return new Response("slow down", { status: 429 });
        if (body.model === "legacy-cost-field") {
          return Response.json({
            choices: [{ message: { content: '{"verdict":"NEUTRAL"}' } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_cost: 0.002 },
          });
        }
        return Response.json({
          choices: [{ message: { content: '{"verdict":"NEUTRAL"}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe("OpenRouterProvider", () => {
  test("complete returns parsed output", async () => {
    const p = new OpenRouterProvider("or", { apiKey: "test-key", baseUrl });
    const out = await p.complete({
      systemPrompt: "s",
      userPrompt: "u",
      model: "anthropic/claude-sonnet",
    });
    expect(out.content).toContain("NEUTRAL");
    expect(out.costUsd).toBe(0.001);
    expect(out.promptTokens).toBe(100);
  });

  test("response_format json_object passed when schema provided", async () => {
    const p = new OpenRouterProvider("or", { apiKey: "test-key", baseUrl });
    const out = await p.complete({
      systemPrompt: "s",
      userPrompt: "u",
      model: "anthropic/claude-sonnet",
      responseSchema: z.object({ verdict: z.string() }),
    });
    expect(out.parsed).toEqual({ verdict: "NEUTRAL" });
  });

  test("429 throws LLMRateLimitError", async () => {
    const p = new OpenRouterProvider("or", { apiKey: "test-key", baseUrl });
    await expect(
      p.complete({ systemPrompt: "s", userPrompt: "u", model: "rate-limit-test" }),
    ).rejects.toThrow(LLMRateLimitError);
  });

  test("monthly budget exhaustion → isAvailable false", async () => {
    const p = new OpenRouterProvider("or", { apiKey: "k", baseUrl, monthlyBudgetUsd: 0 });
    expect(await p.isAvailable()).toBe(false);
  });

  test("legacy total_cost field is also read", async () => {
    const p = new OpenRouterProvider("or", { apiKey: "test-key", baseUrl });
    const out = await p.complete({
      systemPrompt: "s",
      userPrompt: "u",
      model: "legacy-cost-field",
    });
    expect(out.costUsd).toBe(0.002);
  });

  test("isAvailable reads from durable store when provided", async () => {
    const usageStore = new InMemoryLLMUsageStore();
    usageStore.setSpent("or-durable", 10);

    const p = new OpenRouterProvider("or-durable", {
      apiKey: "k",
      baseUrl,
      monthlyBudgetUsd: 5, // budget 5, durable spent 10 → unavailable
      usageStore,
    });

    expect(await p.isAvailable()).toBe(false);

    usageStore.setSpent("or-durable", 1); // now under budget
    expect(await p.isAvailable()).toBe(true);
  });
});
