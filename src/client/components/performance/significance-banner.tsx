import { TriangleAlert } from "lucide-react";

const MIN_SIGNIFICANT_TRADES = 30;

/**
 * Honesty banner: shown when sample size is too small for any aggregate
 * (Sharpe, profit factor, calibration, by-pattern) to be statistically
 * meaningful. The 30-trade threshold isn't magic — it's the conventional
 * floor below which CLT-based confidence intervals on win rate / R blow
 * up wider than the metric itself. Above 30 the metrics START to
 * converge; you really want 100+ for a serious read.
 *
 * Hidden once tradeCount >= 30 to avoid nag.
 */
export function SignificanceBanner({ tradeCount }: { tradeCount: number }) {
  if (tradeCount >= MIN_SIGNIFICANT_TRADES) return null;

  const remaining = MIN_SIGNIFICANT_TRADES - tradeCount;
  const tone =
    tradeCount === 0
      ? "Aucun trade clos avec metrics calculées."
      : tradeCount < 10
        ? "Échantillon trop petit. Tout chiffre ci-dessous est anecdotique, pas statistique."
        : tradeCount < 20
          ? "Échantillon insuffisant. Les métriques ont une marge d'erreur > à leur valeur."
          : `Échantillon limite. Encore ${remaining} trades pour atteindre le seuil minimal de ${MIN_SIGNIFICANT_TRADES}.`;

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-3">
      <TriangleAlert className="size-4 text-amber-400 mt-0.5 shrink-0" />
      <div className="space-y-1">
        <div className="text-xs font-semibold text-amber-300">
          n = {tradeCount} — pas statistiquement significatif
        </div>
        <p className="text-xs text-muted-foreground">
          {tone} La calibration, le profit factor et la breakdown par pattern ne se stabilisent qu'à
          partir de ~{MIN_SIGNIFICANT_TRADES} trades clos. Décide uniquement sur des décisions de
          risk management individuelles, pas sur la stratégie globale.
        </p>
      </div>
    </div>
  );
}
