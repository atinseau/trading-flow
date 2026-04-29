import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";

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
