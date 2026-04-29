import type { FeedbackOutput } from "@domain/schemas/FeedbackOutput";

/**
 * Test fake for the feedback LLM. Returns a pre-programmed `FeedbackOutput`
 * keyed by the request's `inputHash`, allowing deterministic tests of
 * `runFeedbackAnalysis` cache hits / misses without spinning a real model.
 */
export class FakeFeedbackLLM {
  constructor(private readonly responsesByHash: Map<string, FeedbackOutput>) {}

  async run(args: { inputHash: string }): Promise<FeedbackOutput> {
    const r = this.responsesByHash.get(args.inputHash);
    if (!r) {
      throw new Error(`FakeFeedbackLLM: no response for inputHash ${args.inputHash}`);
    }
    return r;
  }
}
