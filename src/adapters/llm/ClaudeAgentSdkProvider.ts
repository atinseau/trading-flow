import { query } from "@anthropic-ai/claude-agent-sdk";
import { LLMRateLimitError, LLMSchemaValidationError } from "@domain/errors";
import type { LLMInput, LLMOutput, LLMProvider } from "@domain/ports/LLMProvider";
import type { LLMUsageStore } from "@domain/ports/LLMUsageStore";

export type ClaudeAgentSdkConfig = {
  workspaceDir: string;
  fallback?: string | null;
  dailyCallBudget?: number;
  usageStore?: LLMUsageStore;
};

function isRateLimitError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /rate.?limit|429|quota|exceed/i.test(msg);
}

function extractJsonFromResponse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    /* fall through */
  }
  const fenced = content.match(/```(?:json)?\s*\n([\s\S]+?)\n```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!);
    } catch {
      /* fall through */
    }
  }
  const braced = content.match(/\{[\s\S]+\}/);
  if (braced) {
    try {
      return JSON.parse(braced[0]);
    } catch {
      /* fall through */
    }
  }
  throw new Error(`No JSON in LLM response: ${content.slice(0, 200)}`);
}

export class ClaudeAgentSdkProvider implements LLMProvider {
  readonly name: string;
  readonly fallback: string | null;
  private callsToday = 0;
  private rateLimitedUntil: Date | null = null;
  private currentDay: string;

  constructor(
    name: string,
    private config: ClaudeAgentSdkConfig,
  ) {
    this.name = name;
    this.fallback = config.fallback ?? null;
    this.currentDay = new Date().toISOString().slice(0, 10);
  }

  async isAvailable(): Promise<boolean> {
    this.maybeResetCounters();
    if (this.rateLimitedUntil && this.rateLimitedUntil > new Date()) return false;
    if (this.config.dailyCallBudget != null) {
      const calls = this.config.usageStore
        ? await this.config.usageStore.getCallsToday(this.name)
        : this.callsToday;
      if (calls >= this.config.dailyCallBudget) return false;
    }
    return true;
  }

  async complete(input: LLMInput): Promise<LLMOutput> {
    this.maybeResetCounters();
    const start = Date.now();

    let prompt = `${input.systemPrompt}\n\n${input.userPrompt}`;
    if (input.images?.length) {
      const refs = input.images
        .map((img) => `@${img.sourceUri.replace(/^file:\/\//, "")}`)
        .join("\n");
      prompt += `\n\n${refs}`;
    }

    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let cacheReadTokens = 0;

    try {
      const stream = query({
        prompt,
        options: {
          model: input.model,
          permissionMode: "bypassPermissions",
          cwd: this.config.workspaceDir,
        },
      });

      for await (const event of stream as AsyncIterable<{
        type: string;
        result?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
        };
      }>) {
        if (event.type === "result" && event.result != null) {
          content = event.result;
          promptTokens = event.usage?.input_tokens ?? 0;
          completionTokens = event.usage?.output_tokens ?? 0;
          cacheReadTokens = event.usage?.cache_read_input_tokens ?? 0;
        }
      }

      this.callsToday++;
    } catch (err) {
      if (isRateLimitError(err)) {
        this.rateLimitedUntil = new Date(Date.now() + 5 * 60_000);
        throw new LLMRateLimitError(`claude_max rate limited: ${(err as Error).message}`);
      }
      throw err;
    }

    let parsed: unknown;
    if (input.responseSchema) {
      try {
        const json = extractJsonFromResponse(content);
        parsed = input.responseSchema.parse(json);
      } catch (err) {
        throw new LLMSchemaValidationError(`Schema validation failed: ${(err as Error).message}`);
      }
    }

    return {
      content,
      parsed,
      costUsd: 0,
      latencyMs: Date.now() - start,
      promptTokens,
      completionTokens,
      cacheReadTokens,
    };
  }

  private maybeResetCounters(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.callsToday = 0;
    }
  }
}
