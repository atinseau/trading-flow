import type { LLMInput, LLMOutput, LLMProvider } from "@domain/ports/LLMProvider";

type FakeOptions = {
  name: string;
  fallback?: string | null;
  available?: boolean;
  completeImpl?: (input: LLMInput) => Promise<LLMOutput>;
};

export class FakeLLMProvider implements LLMProvider {
  readonly name: string;
  readonly fallback: string | null;
  callCount = 0;
  callsLog: LLMInput[] = [];

  private _available: boolean;
  private _completeImpl: (input: LLMInput) => Promise<LLMOutput>;

  constructor(opts: FakeOptions) {
    this.name = opts.name;
    this.fallback = opts.fallback ?? null;
    this._available = opts.available ?? true;
    this._completeImpl = opts.completeImpl ?? this.defaultComplete;
  }

  async isAvailable(): Promise<boolean> {
    return this._available;
  }

  async complete(input: LLMInput): Promise<LLMOutput> {
    this.callCount++;
    this.callsLog.push(input);
    return this._completeImpl(input);
  }

  setAvailable(v: boolean): void {
    this._available = v;
  }

  setCompleteImpl(impl: (input: LLMInput) => Promise<LLMOutput>): void {
    this._completeImpl = impl;
  }

  private defaultComplete = async (_input: LLMInput): Promise<LLMOutput> => ({
    content: '{"verdict":"NEUTRAL","observations":[]}',
    parsed: { type: "NEUTRAL", observations: [] },
    costUsd: 0,
    latencyMs: 1,
    promptTokens: 100,
    completionTokens: 50,
  });

  reset(): void {
    this.callCount = 0;
    this.callsLog = [];
  }
}
