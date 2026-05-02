/**
 * Outcome → display metadata. The Outcome union itself comes from the domain
 * (single source of truth — same type used by deriveOutcome and the DB write
 * path); this module only owns the visual mapping.
 */

import type { Outcome } from "@domain/services/deriveOutcome";

export type { Outcome };

export type OutcomeMeta = {
  label: string;
  short: string;
  emoji: string;
  /** Tailwind classes for a compact badge */
  badge: string;
  /** Tailwind classes for a card border tint */
  border: string;
};

export const OUTCOME_META: Record<Outcome, OutcomeMeta> = {
  WIN: {
    label: "Gagné",
    short: "Win",
    emoji: "🟢",
    badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    border: "border-l-emerald-500",
  },
  PARTIAL_WIN: {
    label: "Partiellement gagné",
    short: "Partial",
    emoji: "🟡",
    badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    border: "border-l-amber-500",
  },
  LOSS: {
    label: "Perdu",
    short: "Loss",
    emoji: "🔴",
    badge: "bg-red-500/15 text-red-400 border-red-500/30",
    border: "border-l-red-500",
  },
  TIME_OUT: {
    label: "Expiré (filled, sans TP/SL)",
    short: "Timeout",
    emoji: "⏱️",
    badge: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    border: "border-l-zinc-500",
  },
  REJECTED: {
    label: "Rejeté par le Finalizer",
    short: "Rejected",
    emoji: "✋",
    badge: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    border: "border-l-zinc-500",
  },
  INVALIDATED_PRE_TRADE: {
    label: "Invalidé avant le trade",
    short: "Pre-invalid.",
    emoji: "⚪",
    badge: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    border: "border-l-zinc-500",
  },
  INVALIDATED_POST_TRADE: {
    label: "Invalidé pendant le trade",
    short: "Post-invalid.",
    emoji: "🟠",
    badge: "bg-orange-500/15 text-orange-400 border-orange-500/30",
    border: "border-l-orange-500",
  },
  EXPIRED_NO_FILL: {
    label: "Expiré sans entry",
    short: "No fill",
    emoji: "⚪",
    badge: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    border: "border-l-zinc-500",
  },
  KILLED: {
    label: "Tué par l'utilisateur",
    short: "Killed",
    emoji: "☠️",
    badge: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    border: "border-l-zinc-500",
  },
};

export function outcomeMeta(outcome: string | null | undefined): OutcomeMeta | null {
  if (!outcome) return null;
  return OUTCOME_META[outcome as Outcome] ?? null;
}

export function liveBadgeClass(): string {
  return "bg-blue-500/15 text-blue-400 border-blue-500/30";
}
