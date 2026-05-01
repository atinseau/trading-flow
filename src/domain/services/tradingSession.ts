/**
 * Coarse trading-session label derived from a UTC timestamp. Forex/crypto
 * sessions overlap; we pick the dominant one for the given hour. Used by
 * the finalizer to bias caution during thin/quiet sessions.
 *
 * Reference (UTC):
 * - Asian (Tokyo): 00:00 – 09:00
 * - London:        07:00 – 16:00
 * - NY:            12:00 – 21:00
 * - Off-hours:     21:00 – 00:00 + Saturday
 *
 * When sessions overlap (London-NY 12:00-16:00 = highest liquidity), we
 * label "london_ny_overlap" to flag the prime window.
 */
export type TradingSession = "asian" | "london" | "ny" | "london_ny_overlap" | "off_hours";

export function getTradingSession(at: Date): TradingSession {
  const day = at.getUTCDay(); // 0 = Sunday
  if (day === 6) return "off_hours"; // Saturday
  const hour = at.getUTCHours();
  if (hour >= 12 && hour < 16) return "london_ny_overlap";
  if (hour >= 7 && hour < 12) return "london";
  if (hour >= 16 && hour < 21) return "ny";
  if (hour >= 0 && hour < 7) return "asian";
  return "off_hours";
}
