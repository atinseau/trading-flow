import { describe, expect, test } from "bun:test";
import { OpenRouterProvider } from "@adapters/llm/OpenRouterProvider";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import { VerdictSchema } from "@domain/schemas/Verdict";
import { z } from "zod";

const runLlm = Boolean(process.env.RUN_LLM) && Boolean(process.env.OPENROUTER_API_KEY);

const DetectorVerdictSchema = z.object({
  corroborations: z.array(
    z.object({
      setup_id: z.string(),
      evidence: z.array(z.string()),
      confidence_delta_suggested: z.number(),
    }),
  ),
  new_setups: z.array(
    z.object({
      type: z.string(),
      direction: z.enum(["LONG", "SHORT"]),
      key_levels: z.object({
        entry: z.number().optional(),
        invalidation: z.number(),
        target: z.number().optional(),
      }),
      initial_score: z.number().min(0).max(100),
      raw_observation: z.string(),
    }),
  ),
  ignore_reason: z.string().nullable(),
});

const FinalizerOutputSchema = z.object({
  go: z.boolean(),
  reasoning: z.string(),
  entry: z.number().optional(),
  stop_loss: z.number().optional(),
  take_profit: z.array(z.number()).optional(),
});

describe.skipIf(!runLlm)("LLM prompt smoke (real OpenRouter)", () => {
  // Use a cheap model for smoke tests — we just want to validate format, not quality.
  // Verify the model name is still current at https://openrouter.ai/models if this fails.
  const cheapModel = "anthropic/claude-haiku-4.5";

  const provider = new OpenRouterProvider("openrouter", {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    monthlyBudgetUsd: 1, // hard cap to prevent runaway in CI
  });

  test("Detector prompt → real LLM → valid JSON parsed by Zod", async () => {
    const detector = await loadPrompt("detector");
    const userPrompt = detector.render({
      asset: "BTCUSDT",
      timeframe: "1h",
      tickAt: "2026-04-28T14:00:00Z",
      indicators: {
        rsi: 58.4,
        ema20: 67234,
        ema50: 66980,
        ema200: 65000,
        atr: 412,
        atrMa20: 380,
        volumeMa20: 689,
        lastVolume: 1247,
        recentHigh: 68500,
        recentLow: 41800,
      },
      aliveSetups: [],
    });

    const result = await provider.complete({
      systemPrompt: "You are a chart analyzer.",
      userPrompt,
      model: cheapModel,
      maxTokens: 1500,
      temperature: 0.3,
      responseSchema: DetectorVerdictSchema,
    });

    // The provider already parses and throws LLMSchemaValidationError on failure.
    // If we got here, the response is valid.
    expect(result.parsed).toBeDefined();
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeLessThan(0.5); // reasonable cap

    const parsed = result.parsed as z.infer<typeof DetectorVerdictSchema>;
    // At least one of: corroborations, new_setups, or ignore_reason is set
    const hasContent =
      parsed.corroborations.length > 0 ||
      parsed.new_setups.length > 0 ||
      parsed.ignore_reason !== null;
    expect(hasContent).toBe(true);
  }, 60_000);

  test("Reviewer prompt → real LLM → valid Verdict", async () => {
    const reviewer = await loadPrompt("reviewer");
    const userPrompt = reviewer.render({
      setup: {
        id: "test-setup-id",
        patternHint: "double_bottom",
        direction: "LONG",
        currentScore: 50,
        invalidationLevel: 41500,
        ageInCandles: 3,
      },
      history: [
        {
          sequence: 1,
          occurredAt: "2026-04-28T11:00:00Z",
          scoreAfter: 25,
          type: "SetupCreated",
          observations: [],
          reasoning: null,
        },
        {
          sequence: 2,
          occurredAt: "2026-04-28T12:00:00Z",
          scoreAfter: 35,
          type: "Strengthened",
          observations: [
            { kind: "volume_confirmation", text: "Volume 1.8x avg, confirme l'achat" },
          ],
          reasoning: "Le double bottom voit son volume se confirmer",
        },
      ],
      tick: { tickAt: "2026-04-28T14:00:00Z" },
      fresh: { lastClose: 42850, indicators: { rsi: 58.4, atr: 412 } },
    });

    const result = await provider.complete({
      systemPrompt: "You refine an existing setup.",
      userPrompt,
      model: cheapModel,
      maxTokens: 1500,
      temperature: 0.3,
      responseSchema: VerdictSchema,
    });

    expect(result.parsed).toBeDefined();
    const verdict = result.parsed as z.infer<typeof VerdictSchema>;
    expect(["STRENGTHEN", "WEAKEN", "NEUTRAL", "INVALIDATE"]).toContain(verdict.type);
    expect(result.costUsd).toBeGreaterThan(0);
  }, 60_000);

  test("Finalizer prompt → real LLM → valid GO/NO_GO", async () => {
    const finalizer = await loadPrompt("finalizer");
    const userPrompt = finalizer.render({
      setup: {
        id: "test-setup-id",
        asset: "BTCUSDT",
        timeframe: "1h",
        patternHint: "double_bottom",
        direction: "LONG",
        currentScore: 85,
        invalidationLevel: 41500,
      },
      historyCount: 4,
      history: [
        { sequence: 1, type: "SetupCreated", scoreAfter: 25 },
        { sequence: 2, type: "Strengthened", scoreAfter: 35 },
        { sequence: 3, type: "Strengthened", scoreAfter: 60 },
        { sequence: 4, type: "Strengthened", scoreAfter: 85 },
      ],
    });

    const result = await provider.complete({
      systemPrompt: "You make the final go/no-go call.",
      userPrompt,
      model: cheapModel,
      maxTokens: 2000,
      temperature: 0.2,
      responseSchema: FinalizerOutputSchema,
    });

    expect(result.parsed).toBeDefined();
    const decision = result.parsed as z.infer<typeof FinalizerOutputSchema>;
    expect(typeof decision.go).toBe("boolean");
    expect(typeof decision.reasoning).toBe("string");
    if (decision.go) {
      expect(decision.entry).toBeDefined();
      expect(decision.stop_loss).toBeDefined();
      expect(decision.take_profit?.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
