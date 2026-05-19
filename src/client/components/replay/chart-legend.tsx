import { REGISTRY } from "@adapters/indicators/IndicatorRegistry";
import { cn } from "@client/lib/utils";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";
import { EVENT_LABELS, visualForEvent } from "./replay-marker-config";

/**
 * Discrete chart legend — explains what each marker shape/text means and
 * which indicator color belongs to which series. Lives as an overlay in
 * the top-left corner of the chart so it never takes up vertical space.
 *
 * Default state : collapsed (just an Info button). Click to expand a
 * vertical panel listing :
 *   1. Indicators visible on the chart, with their color swatches.
 *   2. Marker types present in the current window, with mini shapes
 *      and their human label.
 *
 * Only marker types actually present in the window are listed — keeps
 * the panel short and avoids documenting markers that don't appear
 * (e.g. TPHit on a session where no setup ever filled).
 */

const SHAPE_SVG: Record<string, ReactElement> = {
  circle: (
    <svg width="10" height="10" viewBox="0 0 10 10" role="img" aria-label="circle marker">
      <circle cx="5" cy="5" r="3.5" fill="currentColor" />
    </svg>
  ),
  square: (
    <svg width="10" height="10" viewBox="0 0 10 10" role="img" aria-label="square marker">
      <rect x="1.5" y="1.5" width="7" height="7" fill="currentColor" />
    </svg>
  ),
  arrowUp: (
    <svg width="10" height="10" viewBox="0 0 10 10" role="img" aria-label="up arrow marker">
      <path d="M 5 1 L 9 9 L 1 9 Z" fill="currentColor" />
    </svg>
  ),
  arrowDown: (
    <svg width="10" height="10" viewBox="0 0 10 10" role="img" aria-label="down arrow marker">
      <path d="M 5 9 L 1 1 L 9 1 Z" fill="currentColor" />
    </svg>
  ),
};

const INDICATOR_LABELS: Record<string, string> = {
  ema_stack: "EMA short / mid / long",
  rsi: "RSI",
  volume: "Volume + MA20",
  macd: "MACD",
  bollinger: "Bollinger",
  vwap: "VWAP",
  atr: "ATR",
  swings_bos: "Swings / BOS",
  structure_levels: "POC / range high-low",
  liquidity_pools: "Liquidity pools",
};

export type ChartLegendProps = {
  /** Indicator ids visible on the chart (after user toggles). */
  visibleIndicatorIds: string[];
  /** Event types currently displayed on the chart (within the playhead). */
  eventTypesInWindow: string[];
};

const FALLBACK_PALETTE: ReadonlyArray<string> = ["#94a3b8"];

export function ChartLegend(props: ChartLegendProps) {
  const [expanded, setExpanded] = useState(false);
  // Derive each indicator's palette from REGISTRY → renderConfig.palette.
  // Single source of truth — no risk of legend swatches drifting from
  // what's actually drawn on the chart.
  const palettesById = useMemo(() => {
    const map: Record<string, ReadonlyArray<string>> = {};
    for (const p of REGISTRY) map[p.id] = p.renderConfig.palette;
    return map;
  }, []);
  if (props.visibleIndicatorIds.length === 0 && props.eventTypesInWindow.length === 0) {
    return null;
  }

  return (
    <div className="absolute top-2 left-2 z-10 pointer-events-auto">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border bg-card/85 backdrop-blur px-2 py-1 text-[10px] font-medium",
          "border-border text-muted-foreground hover:text-foreground transition-colors",
        )}
        title={expanded ? "Masquer la légende" : "Afficher la légende du chart"}
      >
        <Info className="size-3" />
        Légende
        {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      </button>
      {expanded && (
        <div className="mt-1 rounded-md border border-border bg-card/90 backdrop-blur p-2 text-[10px] max-w-[260px] space-y-2 shadow-lg">
          {props.visibleIndicatorIds.length > 0 && (
            <section>
              <div className="text-muted-foreground uppercase tracking-wide mb-1">Indicateurs</div>
              <ul className="space-y-0.5">
                {props.visibleIndicatorIds.map((id) => (
                  <li key={id} className="flex items-center gap-1.5">
                    <span className="inline-flex gap-0.5">
                      {(palettesById[id] ?? FALLBACK_PALETTE).map((c, i) => (
                        // Palette swatches are intentionally tiny + the array
                        // is stable across renders for a given indicator id —
                        // a positional key is the natural identifier here.
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: stable palette
                          key={`${id}-swatch-${i}`}
                          className="inline-block size-2 rounded-sm"
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </span>
                    <span className="text-foreground/90">{INDICATOR_LABELS[id] ?? id}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {props.eventTypesInWindow.length > 0 && (
            <section>
              <div className="text-muted-foreground uppercase tracking-wide mb-1">
                Markers (fenêtre courante)
              </div>
              <ul className="space-y-0.5">
                {props.eventTypesInWindow.map((type) => {
                  const visual = visualForEvent(type);
                  if (!visual) return null;
                  const shapeKey = visual.shape;
                  return (
                    <li key={type} className="flex items-center gap-1.5">
                      <span className="inline-flex items-center justify-center size-3.5 text-muted-foreground">
                        {SHAPE_SVG[shapeKey] ?? <span className="text-[9px]">●</span>}
                      </span>
                      <span className="font-mono text-[9px] text-muted-foreground min-w-[2.5em]">
                        {visual.text ?? "—"}
                      </span>
                      <span className="text-foreground/90">{EVENT_LABELS[type] ?? type}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
