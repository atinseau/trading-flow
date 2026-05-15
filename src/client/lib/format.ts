import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";

/**
 * Display timezone for replay UI.
 *
 * Why this is a constant. Bot logs and chart timestamps are always stored
 * in UTC (Binance ticks, replay events, etc.) ; lightweight-charts also
 * exposes UTC seconds. But the user reads the UI in Paris time. Hardcoding
 * `Europe/Paris` everywhere a date is rendered drifts ; this constant +
 * the formatters below are the single source of truth. Swap to a user
 * preference later by reading from a settings hook.
 */
export const DISPLAY_TZ = "Europe/Paris";

const FULL_FMT = new Intl.DateTimeFormat("fr-FR", {
  timeZone: DISPLAY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const DATE_TIME_FMT = new Intl.DateTimeFormat("fr-FR", {
  timeZone: DISPLAY_TZ,
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const TIME_FMT = new Intl.DateTimeFormat("fr-FR", {
  timeZone: DISPLAY_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const DATE_FMT = new Intl.DateTimeFormat("fr-FR", {
  timeZone: DISPLAY_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function toDate(x: Date | string | number): Date {
  if (x instanceof Date) return x;
  return new Date(x);
}

/** Full date + time in Paris timezone (DD/MM/YYYY HH:mm). */
export function fmtParisDateTime(d: Date | string | number): string {
  return FULL_FMT.format(toDate(d));
}

/** Compact "DD/MM HH:mm" — useful for scrubber labels / chart axis. */
export function fmtParisShort(d: Date | string | number): string {
  return DATE_TIME_FMT.format(toDate(d));
}

/** HH:mm only — for sub-axis tick labels when the day is implicit. */
export function fmtParisTime(d: Date | string | number): string {
  return TIME_FMT.format(toDate(d));
}

/** DD/MM/YYYY only. */
export function fmtParisDate(d: Date | string | number): string {
  return DATE_FMT.format(toDate(d));
}

export function fmtRelative(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return formatDistanceToNow(typeof d === "string" ? new Date(d) : d, {
    addSuffix: true,
    locale: fr,
  });
}

export function fmtCost(usd: string | number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  const n = typeof usd === "string" ? Number(usd) : usd;
  return `$${n.toFixed(2)}`;
}

export function fmtScore(score: string | number): string {
  const n = typeof score === "string" ? Number(score) : score;
  return n.toFixed(0);
}
