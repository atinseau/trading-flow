import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentSdkProvider } from "@adapters/llm/ClaudeAgentSdkProvider";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import { VerdictSchema } from "@domain/schemas/Verdict";
import { z } from "zod";

const runLlm = Boolean(process.env.RUN_LLM_CLAUDE) && Boolean(process.env.ANTHROPIC_API_KEY);

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

describe.skipIf(!runLlm)("LLM prompt smoke (real Claude SDK)", () => {
  // Cheap model for smoke tests — validating format, not quality.
  const cheapModel = "claude-haiku-4-5";

  // Each test gets its own throwaway workspace dir — claude-agent-sdk needs cwd
  // and may create transient files there.
  let workspaceDir: string;
  const setupWorkspace = async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "tf-claude-smoke-"));
  };

  test("Detector prompt → real Claude → valid JSON parsed by Zod", async () => {
    await setupWorkspace();
    const provider = new ClaudeAgentSdkProvider("claude_max", { workspaceDir });
    const detector = await loadPrompt("detector");
    const userPrompt = detector.render({
      asset: "BTCUSDT",
      timeframe: "1h",
      tickAt: "2026-04-28T14:00:00Z",
      indicators: {
        rsi: 58.4,
        emaShort: 67234,
        emaMid: 66980,
        emaLong: 65000,
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
      systemPrompt: detector.systemPrompt,
      userPrompt,
      model: cheapModel,
      maxTokens: 1500,
      temperature: 0.3,
      responseSchema: DetectorVerdictSchema,
    });

    expect(result.parsed).toBeDefined();
    const parsed = result.parsed as z.infer<typeof DetectorVerdictSchema>;
    const hasContent =
      parsed.corroborations.length > 0 ||
      parsed.new_setups.length > 0 ||
      parsed.ignore_reason !== null;
    expect(hasContent).toBe(true);
  }, 120_000);

  test("Reviewer prompt → real Claude → valid Verdict", async () => {
    await setupWorkspace();
    const provider = new ClaudeAgentSdkProvider("claude_max", { workspaceDir });
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
            { kind: "volume_confirmation", text: "Volume 1.8x avg confirms buying pressure" },
          ],
          reasoning: "The double bottom is gaining volume confirmation",
        },
      ],
      tick: { tickAt: "2026-04-28T14:00:00Z" },
      fresh: { lastClose: 42850, indicators: { rsi: 58.4, atr: 412 } },
    });

    const result = await provider.complete({
      systemPrompt: reviewer.systemPrompt,
      userPrompt,
      model: cheapModel,
      maxTokens: 1500,
      temperature: 0.3,
      responseSchema: VerdictSchema,
    });

    expect(result.parsed).toBeDefined();
    const verdict = result.parsed as z.infer<typeof VerdictSchema>;
    expect(["STRENGTHEN", "WEAKEN", "NEUTRAL", "INVALIDATE"]).toContain(verdict.type);
  }, 120_000);

  test("Finalizer prompt → real Claude → valid GO/NO_GO", async () => {
    await setupWorkspace();
    const provider = new ClaudeAgentSdkProvider("claude_max", { workspaceDir });
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
      systemPrompt: finalizer.systemPrompt,
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
  }, 120_000);
});
