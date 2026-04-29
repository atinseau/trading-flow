import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentSdkProvider } from "@adapters/llm/ClaudeAgentSdkProvider";
import { resolveAndCall } from "@adapters/llm/resolveAndCall";
import { loadPrompt } from "@adapters/prompts/loadPrompt";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import { FeedbackOutputSchema } from "@domain/schemas/FeedbackOutput";

const RUN = process.env.RUN_LLM_CLAUDE === "1";

// Mirror validateActions: lessons must not name a specific asset or timeframe
// (would taint the global pool).
const TIMEFRAME_REGEX =
  /\b(?:\d+\s*(?:m|min|minute|h|hr|hour|d|day|w|week)s?|hourly|daily|weekly|intraday|swing|scalp|(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty|sixty)[\s-](?:minute|hour|day)s?|[mhdw]\d{1,2})\b/i;
const ASSET_REGEX =
  /\b(BTC|ETH|EUR|USD|JPY|GBP|AAPL|TSLA|SPX|NQ|ES|XAU|GOLD|SILVER|OIL|forex|crypto|stocks?|equities|fx|Bitcoin|Ethereum|Solana|Dogecoin|Cardano|Ripple|Litecoin|DOGE|SOL|ADA|XRP|LTC|BNB|MATIC|USDT|USDC|BUSD|DAI)\b/i;

describe.skipIf(!RUN)("feedback LLM smoke (real claude-opus)", () => {
  test("produces output that passes FeedbackOutputSchema and respects content constraints", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "tf-feedback-smoke-"));
    const provider = new ClaudeAgentSdkProvider("claude_max", { workspaceDir });
    const registry = new Map<string, LLMProvider>([["claude_max", provider]]);

    const feedback = await loadPrompt("feedback");

    // Minimal context: one setup-events chunk with 5 events. No images.
    // Asset/timeframe details are intentionally absent — the prompt is meant to
    // produce *generic* lessons, and we'll assert no asset/TF leaks into output.
    const setupTimeline = [
      "### Setup timeline (5 events)",
      "",
      "#### Tick 1 — SetupCreated",
      "- score: 0 → 25",
      "- pattern: double_bottom",
      "- reasoning: clean retest of prior swing low with bullish divergence",
      "",
      "#### Tick 2 — Strengthened",
      "- score: 25 → 45",
      "  - **volume_confirmation**: volume 1.7x avg on the second low",
      "",
      "#### Tick 3 — Strengthened",
      "- score: 45 → 70",
      "  - **breakout**: clean break of neckline with momentum",
      "",
      "#### Tick 4 — Weakened",
      "- score: 70 → 55",
      "  - **rejection**: failed retest, long upper wicks at resistance",
      "",
      "#### Tick 5 — Invalidated",
      "- score: 55 → 0",
      "  - **stop_hit**: price closed below invalidation, stop loss triggered",
      "",
    ].join("\n");

    const userPrompt = feedback.render({
      closeOutcome: { reason: "sl_hit_direct" },
      scoreAtClose: 55,
      poolStats: { detecting: 0, reviewing: 0, finalizing: 0 },
      maxActivePerCategory: 30,
      existingLessons: [],
      contextChunks: [
        {
          providerId: "setup-events",
          title: "Setup timeline (events)",
          content: { kind: "markdown", value: setupTimeline },
        },
      ],
    });

    const result = await resolveAndCall(
      "claude_max",
      {
        systemPrompt: feedback.systemPrompt,
        userPrompt,
        model: "claude-opus-4-7",
        responseSchema: FeedbackOutputSchema,
      },
      registry,
    );

    expect(result.output.parsed).toBeDefined();
    const parsed = FeedbackOutputSchema.parse(result.output.parsed);

    // Schema guarantees summary length >= 20, but assert non-empty explicitly.
    expect(parsed.summary.trim().length).toBeGreaterThan(0);

    // Content constraints: CREATE/REFINE bodies must not name asset or timeframe.
    for (const action of parsed.actions) {
      if (action.type === "CREATE") {
        const text = `${action.title} ${action.body}`;
        expect(ASSET_REGEX.test(text)).toBe(false);
        expect(TIMEFRAME_REGEX.test(text)).toBe(false);
      } else if (action.type === "REFINE") {
        const text = `${action.newTitle} ${action.newBody}`;
        expect(ASSET_REGEX.test(text)).toBe(false);
        expect(TIMEFRAME_REGEX.test(text)).toBe(false);
      }
    }
  }, 180_000);
});
