import type { LLMUsageStore } from "@domain/ports/LLMUsageStore";

export class InMemoryLLMUsageStore implements LLMUsageStore {
  callsByProvider = new Map<string, number>();
  spentByProvider = new Map<string, number>();

  async getCallsToday(providerName: string): Promise<number> {
    return this.callsByProvider.get(providerName) ?? 0;
  }

  async getSpentMonthUsd(providerName: string): Promise<number> {
    return this.spentByProvider.get(providerName) ?? 0;
  }

  // Test utilities
  setCalls(providerName: string, count: number): void {
    this.callsByProvider.set(providerName, count);
  }

  setSpent(providerName: string, usd: number): void {
    this.spentByProvider.set(providerName, usd);
  }

  reset(): void {
    this.callsByProvider.clear();
    this.spentByProvider.clear();
  }
}
