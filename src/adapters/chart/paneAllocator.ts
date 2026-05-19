export type PaneInput = {
  id: string;
  pane: "price_overlay" | "secondary";
  /** Pixel stretch factor for secondary panes. Defaults to 13. */
  secondaryPaneStretch?: number;
};

export type PaneAllocation = {
  /** Pane index per indicator id (only visible ones — hidden are absent). */
  assignments: Record<string, number>;
  /** Stretch factor to apply per pane index. Always includes [0, 50] for the
   *  main pane, then [N, stretch] for each visible secondary in input order. */
  stretches: Array<[paneIndex: number, stretch: number]>;
};

const MAIN_PANE = 0;
const MAIN_STRETCH = 50;
const DEFAULT_SECONDARY_STRETCH = 13;

export function allocatePanes(
  indicators: ReadonlyArray<PaneInput>,
  visibility: Record<string, boolean>,
): PaneAllocation {
  const assignments: Record<string, number> = {};
  const stretches: Array<[number, number]> = [[MAIN_PANE, MAIN_STRETCH]];
  let nextSecondary = 1;
  for (const ind of indicators) {
    if (!visibility[ind.id]) continue;
    if (ind.pane === "price_overlay") {
      assignments[ind.id] = MAIN_PANE;
    } else {
      const idx = nextSecondary++;
      assignments[ind.id] = idx;
      stretches.push([idx, ind.secondaryPaneStretch ?? DEFAULT_SECONDARY_STRETCH]);
    }
  }
  return { assignments, stretches };
}
