export interface Clock {
  now(): Date;
  candleDurationMs(timeframe: string): number;
}

export function parseTimeframeToMs(timeframe: string): number {
  const match = timeframe.match(/^(\d+)([mhdw])$/);
  if (!match) throw new Error(`Invalid timeframe: ${timeframe}`);
  const n = Number(match[1]);
  const unit = match[2] as "m" | "h" | "d" | "w";
  const factor = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  return n * factor;
}
