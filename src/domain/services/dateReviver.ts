/**
 * JSON.parse reviver that re-hydrates ISO-8601 timestamp strings into
 * native `Date` objects. Used wherever we deserialize OHLCV / events
 * stored as JSON in artifacts or event payloads — the Postgres / Temporal
 * boundary loses the `Date` distinction, so callers must revive on read.
 */
export function dateReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return value;
}
