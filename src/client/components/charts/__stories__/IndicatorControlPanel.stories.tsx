import { IndicatorControlPanel } from "@client/components/charts/IndicatorControlPanel";
import { useState } from "react";

const entries = [
  { id: "ema_stack", displayName: "EMA stack", swatch: "#3b82f6" },
  { id: "rsi", displayName: "RSI", swatch: "#14b8a6" },
  { id: "fibonacci", displayName: "Fibonacci", swatch: "#ef9a9a" },
];

function Demo({ layout }: { layout: "top-chips" | "sidebar-right" | "sidebar-left" }) {
  const [visibility, setVisibility] = useState({
    ema_stack: true,
    rsi: false,
    fibonacci: true,
  });
  return (
    <IndicatorControlPanel
      entries={entries}
      visibility={visibility}
      layout={layout}
      onToggle={(id, v) => setVisibility((s) => ({ ...s, [id]: v }))}
      onShowAll={() => setVisibility({ ema_stack: true, rsi: true, fibonacci: true })}
      onShowNone={() => setVisibility({ ema_stack: false, rsi: false, fibonacci: false })}
    />
  );
}

export default { title: "Chart/IndicatorControlPanel", component: Demo };
export const TopChips = { args: { layout: "top-chips" } };
export const SidebarRight = { args: { layout: "sidebar-right" } };
export const SidebarLeft = { args: { layout: "sidebar-left" } };
