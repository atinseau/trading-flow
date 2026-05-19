import { REGISTRY } from "@adapters/indicators/IndicatorRegistry";
import type { ControlsLayout } from "@client/components/charts/IndicatorControlPanel";
import { TradingViewChart } from "@client/components/charts/TradingViewChart";
import fixtureBullish from "@test-fixtures/candles/btcusdt-1h-bullish-200.json";
import type { UTCTimestamp } from "lightweight-charts";
import { useMemo, useState } from "react";

const candlesForCompute = fixtureBullish.map((c) => ({
  timestamp: new Date(c.time * 1000),
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: c.volume,
}));
const candles = fixtureBullish.map((c) => ({
  time: c.time as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
}));

// Precompute every plugin's contribution once.
const ALL_INDICATORS = REGISTRY.map((plugin) => ({
  id: plugin.id,
  plugin,
  // biome-ignore lint/suspicious/noExplicitAny: bypass strict Candle typing for fixture
  contribution: plugin.computeSeries(candlesForCompute as any),
}));

// Three preset price lines at typical entry/sl/tp distances from the median candle.
const median = candles[Math.floor(candles.length / 2)] ?? candles[0]!;
const PRICE_LINE_PRESETS = [
  { id: "entry", price: median.close, color: "#10b981", title: "Entry", style: 0 as 0 | 1 | 2 },
  { id: "sl", price: median.close - 5, color: "#ef4444", title: "SL", style: 2 as 0 | 1 | 2 },
  { id: "tp", price: median.close + 5, color: "#3b82f6", title: "TP", style: 2 as 0 | 1 | 2 },
];

function Playground() {
  const [enableControls, setEnableControls] = useState(true);
  const [enableFullscreen, setEnableFullscreen] = useState(true);
  const [controlsLayout, setControlsLayout] = useState<ControlsLayout>("top-chips");
  const [height, setHeight] = useState(480);
  const [enabledIndicators, setEnabledIndicators] = useState<Set<string>>(
    () => new Set(["ema_stack", "rsi"]),
  );
  const [enabledPriceLines, setEnabledPriceLines] = useState<Set<string>>(
    () => new Set(["entry", "sl", "tp"]),
  );

  const indicators = useMemo(
    () => ALL_INDICATORS.filter((i) => enabledIndicators.has(i.id)),
    [enabledIndicators],
  );
  const priceLines = useMemo(
    () =>
      PRICE_LINE_PRESETS.filter((p) => enabledPriceLines.has(p.id)).map((p) => ({
        price: p.price,
        color: p.color,
        title: p.title,
        style: p.style,
      })),
    [enabledPriceLines],
  );

  const propsJson = useMemo(
    () =>
      JSON.stringify(
        {
          enableControls,
          enableFullscreen,
          controlsLayout,
          height,
          indicatorIds: [...enabledIndicators],
          priceLines: priceLines.map((p) => ({ price: p.price, title: p.title })),
        },
        null,
        2,
      ),
    [enableControls, enableFullscreen, controlsLayout, height, enabledIndicators, priceLines],
  );

  const toggleIndicator = (id: string) => {
    setEnabledIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const togglePriceLine = (id: string) => {
    setEnabledPriceLines((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 12, width: "100%" }}>
      <aside style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13 }}>
        <section style={{ border: "1px solid #2a2e39", borderRadius: 6, padding: 10 }}>
          <h3 style={{ marginTop: 0, fontSize: 12, textTransform: "uppercase", color: "#94a3b8" }}>
            Component options
          </h3>
          <label style={{ display: "flex", gap: 6, alignItems: "center", padding: "3px 0" }}>
            <input
              type="checkbox"
              checked={enableControls}
              onChange={(e) => setEnableControls(e.target.checked)}
            />
            enableControls
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", padding: "3px 0" }}>
            <input
              type="checkbox"
              checked={enableFullscreen}
              onChange={(e) => setEnableFullscreen(e.target.checked)}
            />
            enableFullscreen
          </label>
          <div style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 4, color: "#94a3b8" }}>controlsLayout</div>
            {(["top-chips", "sidebar-right", "sidebar-left"] as ControlsLayout[]).map((l) => (
              <label
                key={l}
                style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}
              >
                <input
                  type="radio"
                  name="controlsLayout"
                  checked={controlsLayout === l}
                  onChange={() => setControlsLayout(l)}
                />
                {l}
              </label>
            ))}
          </div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
            height
            <input
              type="number"
              value={height}
              min={200}
              max={900}
              step={20}
              onChange={(e) => setHeight(Number(e.target.value))}
              style={{ width: 70 }}
            />
          </label>
        </section>

        <section style={{ border: "1px solid #2a2e39", borderRadius: 6, padding: 10 }}>
          <h3 style={{ marginTop: 0, fontSize: 12, textTransform: "uppercase", color: "#94a3b8" }}>
            Indicators ({enabledIndicators.size} / {REGISTRY.length})
          </h3>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <button
              type="button"
              onClick={() => setEnabledIndicators(new Set(REGISTRY.map((p) => p.id)))}
            >
              All
            </button>
            <button type="button" onClick={() => setEnabledIndicators(new Set())}>
              None
            </button>
          </div>
          {REGISTRY.map((p) => (
            <label
              key={p.id}
              style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}
            >
              <input
                type="checkbox"
                checked={enabledIndicators.has(p.id)}
                onChange={() => toggleIndicator(p.id)}
              />
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: p.renderConfig.palette[0] ?? "#94a3b8",
                }}
              />
              {p.displayName}
            </label>
          ))}
        </section>

        <section style={{ border: "1px solid #2a2e39", borderRadius: 6, padding: 10 }}>
          <h3 style={{ marginTop: 0, fontSize: 12, textTransform: "uppercase", color: "#94a3b8" }}>
            Price lines (caller-supplied)
          </h3>
          {PRICE_LINE_PRESETS.map((p) => (
            <label
              key={p.id}
              style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}
            >
              <input
                type="checkbox"
                checked={enabledPriceLines.has(p.id)}
                onChange={() => togglePriceLine(p.id)}
              />
              <span style={{ color: p.color }}>{p.title}</span>
              <span style={{ color: "#94a3b8", marginLeft: "auto" }}>{p.price.toFixed(2)}</span>
            </label>
          ))}
        </section>

        <section style={{ border: "1px solid #2a2e39", borderRadius: 6, padding: 10 }}>
          <h3 style={{ marginTop: 0, fontSize: 12, textTransform: "uppercase", color: "#94a3b8" }}>
            Live props
          </h3>
          <pre
            style={{
              margin: 0,
              fontSize: 10,
              lineHeight: 1.3,
              color: "#cbd5e1",
              whiteSpace: "pre-wrap",
            }}
          >
            {propsJson}
          </pre>
        </section>
      </aside>

      <div>
        <TradingViewChart
          candles={candles}
          indicators={indicators}
          priceLines={priceLines}
          enableControls={enableControls}
          enableFullscreen={enableFullscreen}
          controlsLayout={controlsLayout}
          height={height}
        />
      </div>
    </div>
  );
}

export default { title: "Charts/Playground", component: Playground };
export const Default = { args: {} };
