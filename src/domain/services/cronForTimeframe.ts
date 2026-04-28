/**
 * Returns a 5-field cron expression that aligns to the close of each candle for
 * the given timeframe. Sub-hour timeframes use `*\/N * * * *` syntax (race window
 * up to a few hundred ms after the candle closes — mitigated by activity retry).
 * Hour-or-larger timeframes align to top-of-period.
 */
export function cronForTimeframe(timeframe: string): string {
  switch (timeframe) {
    case "1m":
      return "* * * * *";
    case "5m":
      return "*/5 * * * *";
    case "15m":
      return "*/15 * * * *";
    case "30m":
      return "*/30 * * * *";
    case "1h":
      return "0 * * * *";
    case "2h":
      return "0 */2 * * *";
    case "4h":
      return "0 */4 * * *";
    case "1d":
      return "0 0 * * *";
    case "1w":
      return "0 0 * * 0";
    default:
      throw new Error(`No cron mapping for timeframe: ${timeframe}`);
  }
}

/**
 * Validates a cron expression has exactly 5 fields (standard minute-resolution).
 * Rejects 6-field (with seconds) and 7-field (with year) extensions.
 * 5-field cron's smallest interval is `* * * * *` = 1 minute, so this naturally
 * enforces a 1-minute minimum.
 */
export function isValidFiveFieldCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  // Each field must contain only valid characters: digits, *, /, ,, -
  const fieldRegex = /^[\d*/,-]+$/;
  return fields.every((f) => fieldRegex.test(f));
}
