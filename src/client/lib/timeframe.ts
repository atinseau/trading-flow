/**
 * Frontend mirror of `domain/replay/replaySessionRules.timeframeToMinutes`.
 * Kept local to the client to avoid importing the entire replaySessionRules
 * module (and its WatchConfig type tree) into the browser bundle.
 */
export function timeframeToMinutes(tf: string): number {
  switch (tf) {
    case "1m":
      return 1;
    case "5m":
      return 5;
    case "15m":
      return 15;
    case "30m":
      return 30;
    case "1h":
      return 60;
    case "2h":
      return 120;
    case "4h":
      return 240;
    case "1d":
      return 1440;
    case "1w":
      return 10080;
    default:
      return 60;
  }
}
