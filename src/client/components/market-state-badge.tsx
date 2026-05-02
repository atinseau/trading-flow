import { Badge } from "@client/components/ui/badge";
import { useMarketSession } from "@client/hooks/useMarketSession";
import type { WatchAssetInput } from "@domain/services/marketSession";
import { Clock } from "lucide-react";

export function formatRelativeOpening(target: Date, now = new Date()): string {
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return "maintenant";

  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return `dans ${diffMin} min`;

  const diffH = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  if (diffH < 24) return `dans ${diffH}h${String(remMin).padStart(2, "0")}`;

  // Within next 7 days → use weekday name
  if (diffMs < 7 * 24 * 3600 * 1000) {
    const dayName = target.toLocaleDateString("fr-FR", { weekday: "long" });
    const time = target.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    return `${dayName} à ${time}`;
  }

  // Beyond 7 days → full date
  const dateStr = target.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  const time = target.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `le ${dateStr} à ${time}`;
}

export function MarketStateBadge({ watch }: { watch: WatchAssetInput }) {
  const { session, state } = useMarketSession(watch);
  // No session info or always-open or currently open → nothing to show
  if (!session || !state) return null;
  if (session.kind === "always-open") return null;
  if (state.isOpen) return null;
  if (!state.nextOpenAt) return null;

  return (
    <Badge variant="outline" className="text-muted-foreground">
      Market closed · ouvre {formatRelativeOpening(state.nextOpenAt)}
    </Badge>
  );
}

/**
 * Tinted banner shown when the market is closed. Two visual variants:
 * - `card` (default): sits flush at the top of a Card (rounded-t, no
 *   bottom rounding, separator border-bottom).
 *   Pair with `<Card className="overflow-hidden">` so the banner clips to
 *   the card's rounded corners.
 * - `page`: standalone full-width alert with rounded border on all sides
 *   and slightly larger text/padding. Use at the top of a detail page.
 *
 * Returns null in all the cases where MarketStateBadge would also return
 * null (always-open, currently open, no session info).
 */
export function MarketClosedBanner({
  watch,
  variant = "card",
}: {
  watch: WatchAssetInput;
  variant?: "card" | "page";
}) {
  const { session, state } = useMarketSession(watch);
  if (!session || !state) return null;
  if (session.kind === "always-open") return null;
  if (state.isOpen) return null;
  if (!state.nextOpenAt) return null;

  const baseClasses =
    "flex items-center gap-2 border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  const variantClasses =
    variant === "page"
      ? "rounded-md border px-4 py-3 text-sm"
      : "rounded-t-lg border-b px-4 py-1.5 text-xs";
  const iconClasses = variant === "page" ? "h-4 w-4 shrink-0" : "h-3 w-3 shrink-0";

  return (
    <div className={`${baseClasses} ${variantClasses}`} role="status">
      <Clock className={iconClasses} aria-hidden="true" />
      <span>
        Marché fermé · réouverture <strong>{formatRelativeOpening(state.nextOpenAt)}</strong>
      </span>
    </div>
  );
}
