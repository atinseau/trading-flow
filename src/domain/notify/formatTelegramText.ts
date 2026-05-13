/**
 * Plain-text formatters for the Telegram messages the bot sends.
 *
 * Single source of truth used by BOTH :
 *  - Live `notifyTelegram*` activities (which pass the string to the
 *    `Notifier` port).
 *  - The replay workflow, which attaches the formatted string to the
 *    `telegramPreview` field on the corresponding `replay_events`
 *    payload — the UI renders it with a "NEUTRALISÉ" badge.
 *
 * Sharing the formatters across both paths eliminates drift risk : a
 * change to the live message (new emoji, new disclaimer) automatically
 * reflects in the replay preview, with no parity test needed.
 *
 * Pure functions, no DI, no IO.
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

/**
 * Layout mirrors the live `notifyTelegramReviewerVerdict` :
 *   - header line with emoji + verdict + signed Δ + asset/timeframe
 *   - "Score: before→after"
 *   - reasoning appended on the next line (no blank line between) when
 *     `includeReasoning` is true and reasoning is non-empty
 */
export function formatReviewerVerdictPreview(args: ReviewerVerdictPreviewInput): string {
  const sign = args.verdict === "STRENGTHEN" ? "+" : "-";
  const emoji = args.verdict === "STRENGTHEN" ? "💪" : "💔";
  const delta = Math.abs(args.scoreAfter - args.scoreBefore);
  const include = args.includeReasoning ?? true;
  return [
    `${emoji} ${args.verdict} ${sign}${delta} — ${args.asset} ${args.timeframe}`,
    `Score: ${args.scoreBefore}→${args.scoreAfter}`,
    "",
    include ? args.reasoning : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
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
