import { cn } from "@client/lib/utils";

/**
 * Chip row to toggle individual indicators on/off on the replay chart.
 *
 * Truly minimal : one toggle per indicator id. The parent owns the
 * `visible` Set ; the toggles never mutate the watch config, only the
 * chart overlay.
 *
 * Label mapping is shared with the prompt fragments (kept in sync by the
 * test asserting the available ids when this list grows).
 */

const INDICATOR_LABELS: Record<string, string> = {
  ema_stack: "EMA stack",
  rsi: "RSI",
  volume: "Volume",
  macd: "MACD",
  bollinger: "Bollinger",
  vwap: "VWAP",
  atr: "ATR",
  swings_bos: "Swings / BOS",
  structure_levels: "Levels (POC/HH/LL)",
  liquidity_pools: "Liquidity",
};

export function IndicatorToggles(props: {
  availableIds: string[];
  visible: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  if (props.availableIds.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">
        Indicateurs :
      </span>
      {props.availableIds.map((id) => {
        const active = props.visible.has(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => props.onToggle(id)}
            className={cn(
              "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-colors",
              active
                ? "border-blue-500/40 bg-blue-500/15 text-blue-300"
                : "border-muted-foreground/30 text-muted-foreground hover:bg-muted/30",
            )}
            title={
              active
                ? `Masquer ${INDICATOR_LABELS[id] ?? id}`
                : `Afficher ${INDICATOR_LABELS[id] ?? id}`
            }
          >
            {INDICATOR_LABELS[id] ?? id}
          </button>
        );
      })}
    </div>
  );
}
