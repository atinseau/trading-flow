import type {
  FeedbackContextChunk,
  FeedbackContextProvider,
  FeedbackContextScope,
} from "@domain/ports/FeedbackContextProvider";

export class FakeFeedbackContextProvider implements FeedbackContextProvider {
  constructor(
    public readonly id: string,
    private readonly chunks: FeedbackContextChunk[],
    private readonly applicable: boolean = true,
  ) {}
  isApplicable(_scope: FeedbackContextScope) {
    return this.applicable;
  }
  async gather(_scope: FeedbackContextScope) {
    return this.chunks;
  }
}
