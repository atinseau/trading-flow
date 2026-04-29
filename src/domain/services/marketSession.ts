import { UnsupportedExchangeError } from "@domain/errors";
import {
  EXCHANGE_DEFS,
  type ExchangeId,
  FOREX_DEF,
  normalizeYahooExchange,
} from "./exchangeCalendars";

export type Session =
  | { kind: "always-open" }
  | { kind: "exchange"; id: ExchangeId }
  | { kind: "forex" };

export type WatchAssetInput = {
  asset: {
    source: string;
    symbol: string;
    quoteType?: string;
    exchange?: string;
  };
};

export function getSession(watch: WatchAssetInput): Session {
  if (watch.asset.source === "binance") return { kind: "always-open" };
  switch (watch.asset.quoteType) {
    case "CURRENCY":
      return { kind: "forex" };
    case "FUTURE":
    case "CRYPTOCURRENCY":
      return { kind: "always-open" };
    case "EQUITY":
    case "ETF":
    case "INDEX": {
      const id = normalizeYahooExchange(watch.asset.exchange);
      if (!id) throw new UnsupportedExchangeError(watch.asset.exchange);
      return { kind: "exchange", id };
    }
    default:
      throw new Error(`Unsupported quoteType: ${watch.asset.quoteType}`);
  }
}

export type SessionState = {
  isOpen: boolean;
  nextOpenAt?: Date;
  nextCloseAt?: Date;
};

export function getSessionState(session: Session, now: Date): SessionState {
  if (session.kind === "always-open") return { isOpen: true };
  if (session.kind === "exchange") return computeExchangeState(session.id, now);
  if (session.kind === "forex") return computeForexState(now);
  // exhaustive — should never reach here
  const _exhaustive: never = session;
  return _exhaustive;
}

// Extract local wall-clock parts in a given IANA tz at instant `date`.
function localPartsInTz(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const wkMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  // Intl with hour12:false sometimes returns "24" for midnight — normalize to 0
  const hourRaw = Number(parts.hour);
  return {
    isoWeekday: wkMap[parts.weekday as string],
    hh: hourRaw === 24 ? 0 : hourRaw,
    mm: Number(parts.minute),
    yyyy: Number(parts.year),
    MM: Number(parts.month),
    dd: Number(parts.day),
  };
}

// Given local wall-clock components in tz, return the UTC instant.
// DST-safe: builds a candidate assuming UTC, then measures the drift between
// what the tz reports back and what we intended, and subtracts it.
// The dayDelta correction handles day-rollover near midnight (e.g., asking for
// 00:30 local when the candidate maps to 23:30 of the previous day in that tz).
function utcFromLocalInTz(
  yyyy: number,
  MM: number,
  dd: number,
  hh: number,
  mm: number,
  tz: string,
): Date {
  // Initial candidate as if components were UTC
  const candidate = new Date(Date.UTC(yyyy, MM - 1, dd, hh, mm));
  const localized = localPartsInTz(candidate, tz);
  // How much is the local clock off from what we wanted?
  const driftMin = (localized.hh - hh) * 60 + (localized.mm - mm);
  // Day rollover: crude but correct for adjacent-day cases
  const dayDelta = localized.dd - dd;
  return new Date(candidate.getTime() - (driftMin + dayDelta * 24 * 60) * 60_000);
}

function parseHHmm(s: string): { hh: number; mm: number } {
  const [hh, mm] = s.split(":").map(Number);
  return { hh, mm };
}

function computeExchangeState(id: ExchangeId, now: Date): SessionState {
  const def = EXCHANGE_DEFS[id];
  const local = localPartsInTz(now, def.tz);
  const minutesNow = local.hh * 60 + local.mm;

  // 1. Are we currently in an open range on a trading day?
  if (def.days.includes(local.isoWeekday)) {
    for (const range of def.ranges) {
      const open = parseHHmm(range.open);
      const close = parseHHmm(range.close);
      const minutesOpen = open.hh * 60 + open.mm;
      const minutesClose = close.hh * 60 + close.mm;
      if (minutesNow >= minutesOpen && minutesNow < minutesClose) {
        return {
          isOpen: true,
          nextCloseAt: utcFromLocalInTz(local.yyyy, local.MM, local.dd, close.hh, close.mm, def.tz),
        };
      }
    }
  }

  // 2. Find next open: walk forward up to 8 days, picking the first range that starts after `now`.
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 24 * 3600_000);
    const probeLocal = localPartsInTz(probe, def.tz);
    if (!def.days.includes(probeLocal.isoWeekday)) continue;
    for (const range of def.ranges) {
      const open = parseHHmm(range.open);
      const candidate = utcFromLocalInTz(
        probeLocal.yyyy,
        probeLocal.MM,
        probeLocal.dd,
        open.hh,
        open.mm,
        def.tz,
      );
      if (candidate.getTime() > now.getTime()) {
        return { isOpen: false, nextOpenAt: candidate };
      }
    }
  }
  throw new Error(`No open in next 8 days for ${id} — bug`);
}

function computeForexState(now: Date): SessionState {
  const local = localPartsInTz(now, FOREX_DEF.tz);
  const open = parseHHmm(FOREX_DEF.open.hhmm); // 17:00 ET Sunday
  const close = parseHHmm(FOREX_DEF.close.hhmm); // 17:00 ET Friday
  const minutesNow = local.hh * 60 + local.mm;
  const minutesOpen = open.hh * 60 + open.mm;
  const minutesClose = close.hh * 60 + close.mm;

  // ISO weekday: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun
  let isOpen: boolean;
  switch (local.isoWeekday) {
    case 1:
    case 2:
    case 3:
    case 4: // Mon–Thu: always open
      isOpen = true;
      break;
    case 5: // Fri: open before 17:00 ET
      isOpen = minutesNow < minutesClose;
      break;
    case 6: // Sat: always closed
      isOpen = false;
      break;
    case 7: // Sun: open at/after 17:00 ET
      isOpen = minutesNow >= minutesOpen;
      break;
    default:
      throw new Error(`unreachable isoWeekday: ${local.isoWeekday}`);
  }

  if (isOpen) {
    // nextCloseAt = upcoming Friday 17:00 ET
    // isoWeekday 1..4 (Mon–Thu): daysToFri = 5 - isoWeekday
    // isoWeekday 5 (Fri, open = before close): 0 days away
    // isoWeekday 7 (Sun, open = after 17:00): 6 days to next Friday
    const daysToFri = local.isoWeekday <= 5 ? 5 - local.isoWeekday : 12 - local.isoWeekday;
    const friProbe = new Date(now.getTime() + daysToFri * 24 * 3600_000);
    const friLocal = localPartsInTz(friProbe, FOREX_DEF.tz);
    return {
      isOpen: true,
      nextCloseAt: utcFromLocalInTz(
        friLocal.yyyy,
        friLocal.MM,
        friLocal.dd,
        close.hh,
        close.mm,
        FOREX_DEF.tz,
      ),
    };
  }

  // Closed: nextOpenAt = upcoming Sunday 17:00 ET
  // Fri (after 17:00): 2 days to Sun
  // Sat: 1 day to Sun
  // Sun (before 17:00): 0 days (today)
  let daysToSun: number;
  if (local.isoWeekday === 5) daysToSun = 2;
  else if (local.isoWeekday === 6) daysToSun = 1;
  else if (local.isoWeekday === 7) daysToSun = 0;
  else throw new Error(`unexpected closed weekday ${local.isoWeekday}`);
  const sunProbe = new Date(now.getTime() + daysToSun * 24 * 3600_000);
  const sunLocal = localPartsInTz(sunProbe, FOREX_DEF.tz);
  return {
    isOpen: false,
    nextOpenAt: utcFromLocalInTz(
      sunLocal.yyyy,
      sunLocal.MM,
      sunLocal.dd,
      open.hh,
      open.mm,
      FOREX_DEF.tz,
    ),
  };
}
