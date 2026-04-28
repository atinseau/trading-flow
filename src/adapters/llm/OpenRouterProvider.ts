import { readFile } from "node:fs/promises";
import { LLMRateLimitError, LLMSchemaValidationError } from "@domain/errors";
import type { LLMImageInput, LLMInput, LLMOutput, LLMProvider } from "@domain/ports/LLMProvider";
import type { LLMUsageStore } from "@domain/ports/LLMUsageStore";
import { getLogger } from "@observability/logger";
import { z } from "zod";

const OpenRouterResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      cost: z.number().optional(),
      total_cost: z.number().optional(),
    })
    .optional(),
});

export type OpenRouterConfig = {
  apiKey: string;
  baseUrl?: string;
  fallback?: string | null;
  monthlyBudgetUsd?: number;
  usageStore?: LLMUsageStore;
};

async function buildMultipartContent(text: string, images: LLMImageInput[]): Promise<unknown[]> {
  const parts: unknown[] = [{ type: "text", text }];
  for (const img of images) {
    const buffer = await readFile(img.sourceUri.replace(/^file:\/\//, ""));
    const base64 = buffer.toString("base64");
    parts.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${base64}` },
    });
  }
  return parts;
}

export class OpenRouterProvider implements LLMProvider {
  readonly name: string;
  readonly fallback: string | null;
  private spentUsdMtd = 0;
  private currentMonth: string;
  private log: ReturnType<typeof getLogger>;

  constructor(
    name: string,
    private config: OpenRouterConfig,
  ) {
    this.name = name;
    this.fallback = config.fallback ?? null;
    this.currentMonth = new Date().toISOString().slice(0, 7);
    this.log = getLogger({ component: "openrouter-provider", provider: name });
  }

  async isAvailable(): Promise<boolean> {
    this.maybeResetCounters();
    if (this.config.monthlyBudgetUsd != null) {
      const spent = this.config.usageStore
        ? await this.config.usageStore.getSpentMonthUsd(this.name)
        : this.spentUsdMtd;
      if (spent >= this.config.monthlyBudgetUsd) return false;
    }
    return true;
  }

  async complete(input: LLMInput): Promise<LLMOutput> {
    this.maybeResetCounters();
    const start = Date.now();
    this.log.info(
      { model: input.model, hasImages: !!input.images?.length },
      "openrouter call starting",
    );

    const userContent = input.images?.length
      ? await buildMultipartContent(input.userPrompt, input.images)
      : input.userPrompt;

    const body = {
      model: input.model,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: input.maxTokens ?? 4096,
      temperature: input.temperature ?? 0.3,
      ...(input.responseSchema ? { response_format: { type: "json_object" } } : {}),
    };

    const response = await fetch(
      `${this.config.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://trading-flow.local",
        },
        body: JSON.stringify(body),
      },
    );

    if (response.status === 429) {
      this.log.warn({ status: 429 }, "openrouter rate limited");
      throw new LLMRateLimitError("openrouter 429");
    }
    if (!response.ok) {
      const text = await response.text();
      this.log.error({ status: response.status }, "openrouter call failed");
      throw new Error(`OpenRouter ${response.status}: ${text}`);
    }

    const rawData = await response.json();
    const data = OpenRouterResponseSchema.parse(rawData);
    const content = data.choices[0].message.content;
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const costUsd = data.usage?.cost ?? data.usage?.total_cost ?? 0;
    this.spentUsdMtd += costUsd;

    let parsed: unknown;
    if (input.responseSchema) {
      try {
        parsed = input.responseSchema.parse(JSON.parse(content));
      } catch (err) {
        throw new LLMSchemaValidationError(`Schema validation: ${(err as Error).message}`);
      }
    }

    this.log.info(
      { costUsd, promptTokens, completionTokens, model: input.model },
      "openrouter call complete",
    );
    return {
      content,
      parsed,
      costUsd,
      latencyMs: Date.now() - start,
      promptTokens,
      completionTokens,
    };
  }

  private maybeResetCounters(): void {
    const month = new Date().toISOString().slice(0, 7);
    if (month !== this.currentMonth) {
      this.currentMonth = month;
      this.spentUsdMtd = 0;
    }
  }
}
