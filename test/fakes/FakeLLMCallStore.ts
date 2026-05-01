import type { LLMCall, LLMCallStore } from "@domain/ports/LLMCallStore";

export class FakeLLMCallStore implements LLMCallStore {
  recorded: LLMCall[] = [];
  async record(call: LLMCall): Promise<void> {
    this.recorded.push(call);
  }
}
