import type { CloseOutcome } from "@domain/feedback/closeOutcome";

export type FeedbackContextScope = {
  setupId: string;
  watchId: string;
  asset: string;
  timeframe: string;
  closeOutcome: CloseOutcome;
  setupCreatedAt: Date;
  setupClosedAt: Date;
  confirmedAt: Date | null;
  /**
   * Score at the time the setup was closed. Sourced from the latest
   * persisted event's `scoreAfter` (or `setup.currentScore` as a fallback)
   * by `gatherFeedbackContext`. Optional because pre-Phase 7 callers (e.g.
   * tests of providers in isolation) don't always supply it — providers
   * that don't need it ignore it.
   */
  scoreAtClose?: number;
};

export type FeedbackContextChunk = {
  providerId: string;
  title: string;
  content:
    | { kind: "markdown"; value: string }
    | { kind: "image"; artifactUri: string; mimeType: string };
  budget?: { estTokens: number };
};

export interface FeedbackContextProvider {
  readonly id: string;
  isApplicable(scope: FeedbackContextScope): boolean;
  gather(scope: FeedbackContextScope): Promise<FeedbackContextChunk[]>;
}
