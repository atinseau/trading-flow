import type {
  FeedbackContextChunk,
  FeedbackContextProvider,
  FeedbackContextScope,
} from "@domain/ports/FeedbackContextProvider";

export async function buildFeedbackContext(
  scope: FeedbackContextScope,
  providers: FeedbackContextProvider[],
): Promise<FeedbackContextChunk[]> {
  const chunks: FeedbackContextChunk[] = [];
  for (const p of providers) {
    if (!p.isApplicable(scope)) continue;
    const result = await p.gather(scope);
    for (const c of result) chunks.push(c);
  }
  return chunks;
}
