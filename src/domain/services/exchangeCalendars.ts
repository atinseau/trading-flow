export type ExchangeDef = {
  tz: string;
  ranges: Array<{ open: string; close: string }>;
  days: number[]; // 1=Mon..5=Fri (ISO weekday)
};

export const EXCHANGE_DEFS = {
  // US
  NASDAQ: { tz: "America/New_York", ranges: [{ open: "09:30", close: "16:00" }], days: [1, 2, 3, 4, 5] },
  NYSE:   { tz: "America/New_York", ranges: [{ open: "09:30", close: "16:00" }], days: [1, 2, 3, 4, 5] },
  AMEX:   { tz: "America/New_York", ranges: [{ open: "09:30", close: "16:00" }], days: [1, 2, 3, 4, 5] },
  ARCA:   { tz: "America/New_York", ranges: [{ open: "09:30", close: "16:00" }], days: [1, 2, 3, 4, 5] },
  // Europe
  PAR:    { tz: "Europe/Paris",     ranges: [{ open: "09:00", close: "17:30" }], days: [1, 2, 3, 4, 5] },
  AMS:    { tz: "Europe/Amsterdam", ranges: [{ open: "09:00", close: "17:30" }], days: [1, 2, 3, 4, 5] },
  BRU:    { tz: "Europe/Brussels",  ranges: [{ open: "09:00", close: "17:30" }], days: [1, 2, 3, 4, 5] },
  MIL:    { tz: "Europe/Rome",      ranges: [{ open: "09:00", close: "17:30" }], days: [1, 2, 3, 4, 5] },
  LSE:    { tz: "Europe/London",    ranges: [{ open: "08:00", close: "16:30" }], days: [1, 2, 3, 4, 5] },
  XETRA:  { tz: "Europe/Berlin",    ranges: [{ open: "09:00", close: "17:30" }], days: [1, 2, 3, 4, 5] },
  SIX:    { tz: "Europe/Zurich",    ranges: [{ open: "09:00", close: "17:30" }], days: [1, 2, 3, 4, 5] },
  // Asia — lunch breaks modeled explicitly
  TSE:    { tz: "Asia/Tokyo",
            ranges: [{ open: "09:00", close: "11:30" }, { open: "12:30", close: "15:00" }],
            days: [1, 2, 3, 4, 5] },
  HKEX:   { tz: "Asia/Hong_Kong",
            ranges: [{ open: "09:30", close: "12:00" }, { open: "13:00", close: "16:00" }],
            days: [1, 2, 3, 4, 5] },
} as const;

export type ExchangeId = keyof typeof EXCHANGE_DEFS;

export const FOREX_DEF = {
  tz: "America/New_York",
  open: { weekday: 0 as const, hhmm: "17:00" },  // Sun 17:00 ET (DST handled)
  close: { weekday: 5 as const, hhmm: "17:00" }, // Fri 17:00 ET
};

const YAHOO_EXCHANGE_MAP: Record<string, ExchangeId> = {
  NMS: "NASDAQ", NCM: "NASDAQ", NGM: "NASDAQ",
  NYQ: "NYSE", ASE: "AMEX", PCX: "ARCA",
  PAR: "PAR", AMS: "AMS", BRU: "BRU", MIL: "MIL",
  LSE: "LSE", GER: "XETRA", FRA: "XETRA",
  EBS: "SIX", JPX: "TSE", HKG: "HKEX",
};

export function normalizeYahooExchange(code: string | undefined): ExchangeId | null {
  if (!code) return null;
  return YAHOO_EXCHANGE_MAP[code] ?? null;
}
