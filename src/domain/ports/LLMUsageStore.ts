export interface LLMUsageStore {
  /**
   * Returns the number of LLM calls made today by the given provider.
   * Counts events where provider === providerName AND occurredAt is in the current UTC day.
   */
  getCallsToday(providerName: string): Promise<number>;

  /**
   * Returns the total USD spent month-to-date by the given provider.
   * Sums events.cost_usd where provider === providerName AND occurredAt is in the current UTC month.
   */
  getSpentMonthUsd(providerName: string): Promise<number>;
}
