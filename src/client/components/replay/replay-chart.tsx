import { REGISTRY } from "@adapters/indicators/IndicatorRegistry";
import {
  type EventMarkerSpec,
  type IndicatorEntry,
  type PriceLineSpec,
  TradingViewChart,
} from "@client/components/charts/TradingViewChart";
import type { IndicatorSeriesContribution } from "@domain/charts/types";
import type { UTCTimestamp } from "lightweight-charts";
import { useMemo } from "react";
import { colorForSetup, visualForEvent } from "./replay-marker-config";
import type { ReplayEventRow, SetupProjectionRow } from "./replay-types";

export type IndicatorPane = "price_overlay" | "secondary";

export type ReplayCandle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export function ReplayChart(props: {
  candles: ReplayCandle[];
  events: ReplayEventRow[];
  setups: SetupProjectionRow[];
  windowStartAt: Date;
  windowEndAt: Date;
  playheadAt: Date;
  activeSetupId: string | null;
  indicators?: Record<string, IndicatorSeriesContribution>;
  indicatorMeta?: Record<string, { pane: IndicatorPane }>;
}) {
  const playheadSec = useMemo(
    () => Math.floor(props.playheadAt.getTime() / 1000),
    [props.playheadAt],
  );

  // Show all candles in the window up to (and including) the playhead. The
  // scrubber position is conveyed by the candle cutoff itself; lookback
  // candles (pre-windowStartAt) are kept for context in full colors.
  const candles = useMemo(
    () =>
      props.candles
        .map((c) => {
          const time = Math.floor(new Date(c.timestamp).getTime() / 1000) as UTCTimestamp;
          if (time > playheadSec) return null;
          return { time, open: c.open, high: c.high, low: c.low, close: c.close };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null),
    [props.candles, playheadSec],
  );

  // Map server-shipped indicator contributions to TradingViewChart's
  // IndicatorEntry shape. Skip ids the frontend registry doesn't recognize
  // (could happen if backend rolls out a new plugin before frontend).
  const indicators: IndicatorEntry[] = useMemo(() => {
    const out: IndicatorEntry[] = [];
    for (const [id, contribution] of Object.entries(props.indicators ?? {})) {
      const plugin = REGISTRY.find((p) => p.id === id);
      if (!plugin) continue;
      out.push({
        id,
        plugin: plugin as IndicatorEntry["plugin"],
        contribution,
      });
    }
    return out;
  }, [props.indicators]);

  // Event markers: filter to playhead + (optionally) active setup. Color
  // by setup id so the user can tell multiple setups apart.
  const markers: EventMarkerSpec[] = useMemo(() => {
    const playMs = props.playheadAt.getTime();
    const out: EventMarkerSpec[] = [];
    for (const e of props.events) {
      if (new Date(e.occurredAt).getTime() > playMs) continue;
      if (props.activeSetupId && e.setupId !== props.activeSetupId) continue;
      const v = visualForEvent(e.type);
      if (!v) continue;
      out.push({
        time: Math.floor(new Date(e.occurredAt).getTime() / 1000) as UTCTimestamp,
        position: v.position === "inBar" ? "aboveBar" : v.position,
        shape: v.shape,
        color: colorForSetup(e.setupId),
        text: v.text ?? "",
      });
    }
    return out;
  }, [props.events, props.activeSetupId, props.playheadAt]);

  // Setup price lines: Entry / SL / TP × N / Invalidation. One color per
  // setup id, short tag prefix on the axis label so multi-setup views
  // remain readable.
  const priceLines: PriceLineSpec[] = useMemo(() => {
    const scoped = props.activeSetupId
      ? props.setups.filter((s) => s.setupId === props.activeSetupId)
      : props.setups;
    const out: PriceLineSpec[] = [];
    for (const s of scoped) {
      const color = colorForSetup(s.setupId);
      const idTag = color.replace("#", "").slice(0, 3);
      const label = (level: string) => `${idTag} · ${level}`;
      if (s.entry !== null) {
        out.push({ price: s.entry, color, title: label("Entry"), style: 0 });
      }
      if (s.stopLoss !== null) {
        out.push({ price: s.stopLoss, color, title: label("SL"), style: 2 });
      }
      if (s.takeProfit) {
        s.takeProfit.forEach((tp, i) => {
          out.push({ price: tp, color, title: label(`TP${i + 1}`), style: 2 });
        });
      }
      if (s.invalidationLevel !== null) {
        out.push({
          price: s.invalidationLevel,
          color,
          title: label("Inval"),
          style: 1,
        });
      }
    }
    return out;
  }, [props.setups, props.activeSetupId]);

  // initialVisibility: all available indicators hidden by default — the
  // user reveals each via the framework's chip toggles. Preserves the
  // pre-refactor UX where you "discover" indicators progressively.
  const initialVisibility = useMemo(
    () => Object.fromEntries(indicators.map((i) => [i.id, false])),
    [indicators],
  );

  return (
    <TradingViewChart
      candles={candles}
      indicators={indicators}
      priceLines={priceLines}
      markers={markers}
      enableControls
      enableFullscreen
      initialVisibility={initialVisibility}
      height={380}
    />
  );
}
