export type IndicatorSeriesContribution =
  | { kind: "lines"; series: Record<string, (number | null)[]> }
  | {
      kind: "histogram";
      values: ({ value: number; color: string } | number | null)[];
    }
  | {
      kind: "markers";
      markers: Array<{
        index: number;
        position: "above" | "below";
        text: string;
        color: string;
        shape: "arrowUp" | "arrowDown" | "circle" | "square";
      }>;
    }
  | {
      kind: "priceLines";
      lines: Array<{
        price: number;
        color: string;
        style: 0 | 1 | 2;
        title: string;
      }>;
    }
  | { kind: "compound"; parts: IndicatorSeriesContribution[] };
