import type { IndicatorPluginMetadata } from "@domain/services/IndicatorPlugin";
import { emaStackMetadata } from "@adapters/indicators/plugins/ema_stack/metadata";
import { vwapMetadata } from "@adapters/indicators/plugins/vwap/metadata";
import { bollingerMetadata } from "@adapters/indicators/plugins/bollinger/metadata";
import { rsiMetadata } from "@adapters/indicators/plugins/rsi/metadata";
import { macdMetadata } from "@adapters/indicators/plugins/macd/metadata";
import { atrMetadata } from "@adapters/indicators/plugins/atr/metadata";
import { volumeMetadata } from "@adapters/indicators/plugins/volume/metadata";
import { swingsBosMetadata } from "@adapters/indicators/plugins/swings_bos/metadata";
import { structureLevelsMetadata } from "@adapters/indicators/plugins/structure_levels/metadata";
import { liquidityPoolsMetadata } from "@adapters/indicators/plugins/liquidity_pools/metadata";

export const INDICATOR_METADATA: ReadonlyArray<IndicatorPluginMetadata> = [
  emaStackMetadata, vwapMetadata, bollingerMetadata,
  rsiMetadata, macdMetadata, atrMetadata,
  volumeMetadata,
  swingsBosMetadata, structureLevelsMetadata, liquidityPoolsMetadata,
] as const;

export const INDICATOR_METADATA_BY_TAG: Record<string, IndicatorPluginMetadata[]> =
  INDICATOR_METADATA.reduce<Record<string, IndicatorPluginMetadata[]>>((acc, m) => {
    (acc[m.tag] = acc[m.tag] ?? []).push(m);
    return acc;
  }, {});
