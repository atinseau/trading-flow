import { z } from "zod";
import type { IndicatorPlugin } from "@domain/services/IndicatorPlugin";
import { volumeMetadata } from "./metadata";
import { computeScalars, computeSeries } from "./compute";
import { detectorFragment as detectorPromptFragment } from "./promptFragments";
import { CHART_SCRIPT } from "./chartScript";

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
  chartScript: CHART_SCRIPT, chartPane: "secondary", secondaryPaneStretch: 13,
  detectorPromptFragment,
  breakdownAxes: ["volume"],
  preFilterCriterion: "volume_spike_min",
};
