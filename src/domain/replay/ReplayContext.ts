/**
 * Replay execution context.
 *
 * When passed as an argument to a domain activity (`runDetector`,
 * `runReviewer`, `runFinalizer`, `runFeedbackAnalysis`, `persistEvent`,
 * `markSetupClosed`, `notifyTelegram*`), the activity switches its DI to
 * replay-scoped adapters: writes go to `replay_events` instead of `events`,
 * notifier becomes `NoopTelegramNotifier`, clock is fixed to `tickAt`, LLM
 * provider is the `CachedLLMProvider`.
 *
 * When absent, the activity runs in its normal live mode — production
 * behavior is unchanged.
 *
 * This single optional parameter is the keystone of the live/replay
 * branching strategy (see spec §3 "Principe d'économie de code" and §5
 * "Le branchement DI dans les activités existantes").
 */
export type ReplayContext = {
  /** UUID of the `replay_sessions` row driving this invocation. */
  sessionId: string;
  /** Simulated time for this invocation (= the candle's playhead). */
  tickAt: Date;
  /**
   * Which lessons should be injected into Detector/Reviewer/Finalizer
   * prompts during this replay (see spec §6 "Lookup des lessons").
   */
  lessonsMode: "current" | "historical" | "disabled";
  /**
   * Whether the feedback loop runs on trade close during this replay
   * (see spec §6 step 8 + decision #17).
   */
  feedbackMode: "run" | "skip";
};
