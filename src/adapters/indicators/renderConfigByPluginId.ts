import type { RenderConfig } from "@domain/charts/types";

/**
 * TEMPORARY — to be deleted in Phase 4 once every plugin owns its own
 * `renderConfig`. Until then this is the bridge that lets the new
 * `<TradingViewChart>` and the migrated replay-chart resolve palettes
 * from the plugin id alone.
 *
 * Mirrors `INDICATOR_PALETTES` from the old `replay-chart.tsx` + the
 * inline colors baked in each plugin's `chartScript.ts`.
 */
export const RENDER_CONFIG_BY_PLUGIN_ID: Record<string, RenderConfig> = {
  ema_stack: {
    pane: "price_overlay",
    palette: ["#3b82f6", "#f59e0b", "#ef4444"],
    seriesLabels: { ema_short: "EMA short", ema_mid: "EMA mid", ema_long: "EMA long" },
  },
  rsi: { pane: "secondary", palette: ["#14b8a6"], secondaryPaneStretch: 13 },
  bollinger: { pane: "price_overlay", palette: ["#a78bfa", "#a78bfa", "#a78bfa"] },
  macd: { pane: "secondary", palette: ["#3b82f6", "#f59e0b"], secondaryPaneStretch: 15 },
  atr: { pane: "secondary", palette: ["#f97316"], secondaryPaneStretch: 13 },
  vwap: { pane: "price_overlay", palette: ["#10b981"] },
  volume: { pane: "secondary", palette: ["#94a3b8"], secondaryPaneStretch: 13 },
  swings_bos: { pane: "price_overlay", palette: ["#94a3b8"] },
  structure_levels: { pane: "price_overlay", palette: ["#9ca3af"] },
  liquidity_pools: { pane: "price_overlay", palette: ["#a78bfa"] },
  fibonacci: { pane: "price_overlay", palette: ["#ef9a9a", "#ffcc80", "#90caf9"] },
};

export function resolveRenderConfig(pluginId: string): RenderConfig {
  const cfg = RENDER_CONFIG_BY_PLUGIN_ID[pluginId];
  if (!cfg) {
    throw new Error(`[renderConfigByPluginId] unknown plugin "${pluginId}"`);
  }
  return cfg;
}
