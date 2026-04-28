// Zod v4: ZodTypeAny is deprecated — use ZodType (without generics) instead.
import type { ZodType } from "zod";

export type LLMImageInput = {
  sourceUri: string;
  mimeType: string;
};

export type LLMInput = {
  systemPrompt: string;
  userPrompt: string;
  images?: LLMImageInput[];
  responseSchema?: ZodType;
  model: string;
  maxTokens?: number;
  temperature?: number;
};

export type LLMOutput = {
  content: string;
  parsed?: unknown;
  costUsd: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export interface LLMProvider {
  readonly name: string;
  readonly fallback: string | null;
  isAvailable(): Promise<boolean>;
  complete(input: LLMInput): Promise<LLMOutput>;
}
