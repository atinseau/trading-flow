import type { RenderConfig } from "@domain/charts/types";
import type { IndicatorId, WatchConfig } from "@domain/schemas/WatchesConfig";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { atrPlugin } from "./plugins/atr";
import { bollingerPlugin } from "./plugins/bollinger";
import { emaStackPlugin } from "./plugins/ema_stack";
import { liquidityPoolsPlugin } from "./plugins/liquidity_pools";
import { macdPlugin } from "./plugins/macd";
import { rsiPlugin } from "./plugins/rsi";
import { structureLevelsPlugin } from "./plugins/structure_levels";
import { swingsBosPlugin } from "./plugins/swings_bos";
import { volumePlugin } from "./plugins/volume";
import { vwapPlugin } from "./plugins/vwap";

export const REGISTRY: ReadonlyArray<IndicatorPlugin> = [
  emaStackPlugin,
  vwapPlugin,
  bollingerPlugin,
  rsiPlugin,
  macdPlugin,
  atrPlugin,
  volumePlugin,
  swingsBosPlugin,
  structureLevelsPlugin,
  liquidityPoolsPlugin,
] as const;

export class IndicatorRegistry {
  constructor(private plugins: ReadonlyArray<IndicatorPlugin> = REGISTRY) {}

  resolveActive(matrix: WatchConfig["indicators"]): IndicatorPlugin[] {
    return this.plugins.filter((p) => matrix[p.id]?.enabled === true);
  }

  byId(id: IndicatorId): IndicatorPlugin | undefined {
    return this.plugins.find((p) => p.id === id);
  }

  /**
   * Returns each plugin's renderConfig keyed by plugin id. Used by
   * PlaywrightChartRenderer to ship per-indicator render preferences into
   * the page payload (since the page-side dispatcher can't import the
   * plugin objects).
   */
  allRenderConfigs(): Record<string, RenderConfig> {
    return Object.fromEntries(this.plugins.map((p) => [p.id, p.renderConfig]));
  }

  all(): ReadonlyArray<IndicatorPlugin> {
    return this.plugins;
  }
}
