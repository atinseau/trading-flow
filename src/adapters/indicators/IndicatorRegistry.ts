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

  allChartScripts(): string {
    return this.plugins.map((p) => p.chartScript).join("\n");
  }

  all(): ReadonlyArray<IndicatorPlugin> {
    return this.plugins;
  }
}
