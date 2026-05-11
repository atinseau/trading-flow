/**
 * Plain-text formatters that mirror the messages built by the live
 * `notifyTelegram*` activities in `src/workflows/setup/activities.ts`.
 * The replay workflow uses these to attach a `telegramPreview` field to
 * the events that would have triggered a notification in production —
 * the UI then renders the preview with a "NEUTRALISÉ" badge.
 *
 * Kept as pure functions (no DI, no IO) so :
 *   - The replay workflow can call them inline without proxying an
 *     activity.
 *   - Live activities CAN migrate to use them later if we want to
 *     deduplicate, but for now the live formatters stay untouched.
 *
 * Layout decision : the previews are intentionally faithful to the live
 * messages (same emojis, same line breaks) so a user comparing a replay
 * UI to a real Telegram history can match them visually.
 */

export type SetupCreatedPreviewInput = {
  watchId: string;
  asset: string;
  timeframe: string;
  patternHint: string;
  direction: "LONG" | "SHORT";
  initialScore: number;
  invalidationLevel: number;
  rawObservation: string;
};

export function formatSetupCreatedPreview(args: SetupCreatedPreviewInput): string {
  const arrow = args.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  return [
    `🆕 New setup detected — ${args.watchId}`,
    `${args.asset} ${args.timeframe} | ${arrow} | pattern=${args.patternHint}`,
    `Score initial: ${args.initialScore}/100`,
    `Invalidation: ${args.invalidationLevel}`,
    "",
    args.rawObservation,
  ].join("\n");
}

export type ReviewerVerdictPreviewInput = {
  asset: string;
  timeframe: string;
  verdict: "STRENGTHEN" | "WEAKEN";
  scoreBefore: number;
  scoreAfter: number;
  reasoning: string;
  includeReasoning?: boolean;
};

export function formatReviewerVerdictPreview(args: ReviewerVerdictPreviewInput): string {
  const sign = args.verdict === "STRENGTHEN" ? "+" : "-";
  const emoji = args.verdict === "STRENGTHEN" ? "💪" : "💔";
  const delta = Math.abs(args.scoreAfter - args.scoreBefore);
  const include = args.includeReasoning ?? true;
  const lines = [
    `${emoji} ${args.verdict} ${sign}${delta} — ${args.asset} ${args.timeframe}`,
    `Score: ${args.scoreBefore}→${args.scoreAfter}`,
  ];
  if (include && args.reasoning) lines.push("", args.reasoning);
  return lines.join("\n");
}

export type ConfirmedPreviewInput = {
  asset: string;
  timeframe: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: number[];
  reasoning: string;
  includeReasoning?: boolean;
};

export function formatConfirmedPreview(args: ConfirmedPreviewInput): string {
  const arrow = args.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const tpStr = args.takeProfit.length ? `\nTP: ${args.takeProfit.join(" / ")}` : "";
  const reasoning = (args.includeReasoning ?? true) ? `\n\n${args.reasoning}` : "";
  return `${arrow} ${args.asset} ${args.timeframe}\nEntry: ${args.entry}\nSL: ${args.stopLoss}${tpStr}${reasoning}`;
}

export type RejectedPreviewInput = {
  asset: string;
  timeframe: string;
  reasoning: string;
};

export function formatRejectedPreview(args: RejectedPreviewInput): string {
  return `❌ Setup ${args.asset} ${args.timeframe} rejected\n\n${args.reasoning}`;
}

export type TPHitPreviewInput = {
  asset: string;
  timeframe: string;
  level: number;
  index: number;
  isFinal: boolean;
};

export function formatTPHitPreview(args: TPHitPreviewInput): string {
  const tpLabel = `TP${args.index + 1}`;
  const finalStr = args.isFinal ? " (final, position closed)" : "";
  return `🎯 ${tpLabel} hit on ${args.asset} ${args.timeframe} @ ${args.level}${finalStr}`;
}

export type SLHitPreviewInput = {
  asset: string;
  timeframe: string;
  level: number;
};

export function formatSLHitPreview(args: SLHitPreviewInput): string {
  return `🛑 SL hit on ${args.asset} ${args.timeframe} @ ${args.level} — position closed`;
}

export type ExpiredPreviewInput = {
  asset: string;
  timeframe: string;
};

export function formatExpiredPreview(args: ExpiredPreviewInput): string {
  return `⏱ Setup expired (TTL reached) on ${args.asset} ${args.timeframe}`;
}

export type InvalidatedAfterConfirmedPreviewInput = {
  asset: string;
  timeframe: string;
  reason: string;
};

export function formatInvalidatedAfterConfirmedPreview(
  args: InvalidatedAfterConfirmedPreviewInput,
): string {
  return `⚠️ ${args.asset} ${args.timeframe} invalidated post-confirmation\nReason: ${args.reason}`;
}
