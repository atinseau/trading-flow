import { createHash } from "node:crypto";

export type FeedbackInputHashInput = {
  promptVersion: string;
  contextChunkHashes: string[];
  existingLessonIds: string[];
};

/**
 * Deterministic content hash for feedback LLM idempotence.
 *
 * Used to dedupe `runFeedbackAnalysis` retries: if a prior call with the same
 * `inputHash` already produced lesson_events, we can replay them instead of
 * re-running the model.
 *
 * `existingLessonIds` is sorted internally so the hash is order-independent —
 * pool ordering must not invalidate the cache.
 */
export function computeFeedbackInputHash(input: FeedbackInputHashInput): string {
  const sorted = [...input.existingLessonIds].sort();
  const payload = JSON.stringify({
    promptVersion: input.promptVersion,
    contextChunkHashes: input.contextChunkHashes,
    existingLessonIds: sorted,
  });
  return createHash("sha256").update(payload).digest("hex");
}
