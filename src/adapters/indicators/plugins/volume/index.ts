import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { z } from "zod";
import { computeScalars, computeSeries } from "./compute";
import { volumeMetadata } from "./metadata";
import {
  detectorFragment as detectorPromptFragment,
  featuredFewShotExample,
} from "./promptFragments";

export const volumePlugin: IndicatorPlugin = {
  ...volumeMetadata,
  computeScalars,
  computeSeries: (c) => {
    const s = computeSeries(c);
    return { kind: "lines", series: { volumeMa20: s.volumeMa20 } };
  },
  scalarSchemaFragment: () => ({
    volumeMa20: z.number().nonnegative(),
    lastVolume: z.number().nonnegative(),
    volumePercentile200: z.number().min(0).max(100),
  }),
  chartPane: "secondary",
  secondaryPaneStretch: 13,
  renderConfig: {
    pane: "secondary",
    palette: ["#94a3b8", "#ab47bc"],
    secondaryPaneStretch: 13,
    seriesLabels: { volume: "Volume", volumeMa20: "Vol MA20" },
  },
  detectorPromptFragment,
  featuredFewShotExample,
  breakdownAxes: ["volume"],
  preFilterCriterion: "volume_spike_min",
};
