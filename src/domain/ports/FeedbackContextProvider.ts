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
