export type SetupStatus =
  | "CANDIDATE"
  | "REVIEWING"
  | "FINALIZING"
  | "TRACKING"
  | "CLOSED"
  | "INVALIDATED"
  | "EXPIRED"
  | "REJECTED"
  // User cancelled the setup mid-flight via Telegram (kill button).
  // Always terminal — no further reviewer/finalizer ticks fire after this.
  | "KILLED";

export const TERMINAL_STATUSES: ReadonlySet<SetupStatus> = new Set([
  "CLOSED",
  "INVALIDATED",
  "EXPIRED",
  "REJECTED",
  "KILLED",
]);

export const ACTIVE_STATUSES: ReadonlySet<SetupStatus> = new Set([
  "REVIEWING",
  "FINALIZING",
  "TRACKING",
]);

export function isTerminal(s: SetupStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}

export function isActive(s: SetupStatus): boolean {
  return ACTIVE_STATUSES.has(s);
}
