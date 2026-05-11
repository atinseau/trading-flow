import type { SeriesMarkerShape } from "lightweight-charts";

/**
 * Maps replay event types to a marker visual (shape + color + position).
 * Colors per setup are computed independently in the chart component
 * via a stable hash → palette.
 */
export type MarkerVisual = {
  shape: SeriesMarkerShape;
  position: "aboveBar" | "belowBar" | "inBar";
  text?: string;
};

const PALETTE = [
  "#60a5fa", // blue
  "#a78bfa", // violet
  "#f472b6", // pink
  "#34d399", // emerald
  "#fbbf24", // amber
  "#22d3ee", // cyan
];

export function colorForSetup(setupId: string | null): string {
  if (!setupId) return "#9ca3af";
  let hash = 0;
  for (let i = 0; i < setupId.length; i++) {
    hash = ((hash << 5) - hash + setupId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? "#9ca3af";
}

export function visualForEvent(eventType: string): MarkerVisual | null {
  switch (eventType) {
    case "DetectorTickProcessed":
      // Ignored ticks shown as small grey circle (filtered out by chart at high density).
      return { shape: "circle", position: "belowBar" };
    case "SetupCreated":
      return { shape: "circle", position: "aboveBar", text: "S" };
    case "Strengthened":
      return { shape: "square", position: "aboveBar", text: "+" };
    case "Weakened":
      return { shape: "square", position: "belowBar", text: "−" };
    case "Neutral":
      return { shape: "circle", position: "belowBar" };
    case "Confirmed":
      return { shape: "arrowUp", position: "belowBar", text: "GO" };
    case "Rejected":
      return { shape: "arrowDown", position: "aboveBar", text: "NO_GO" };
    case "EntryFilled":
      return { shape: "square", position: "inBar", text: "E" };
    case "TPHit":
      return { shape: "arrowUp", position: "belowBar", text: "TP" };
    case "SLHit":
      return { shape: "arrowDown", position: "aboveBar", text: "SL" };
    case "TrailingMoved":
      return { shape: "circle", position: "aboveBar", text: "T" };
    case "Expired":
      return { shape: "circle", position: "aboveBar", text: "X" };
    case "Invalidated":
    case "PriceInvalidated":
      return { shape: "arrowDown", position: "aboveBar", text: "INV" };
    case "Killed":
      return { shape: "square", position: "aboveBar", text: "K" };
    case "FeedbackLessonProposed":
      return { shape: "circle", position: "aboveBar", text: "💡" };
    default:
      return null;
  }
}
