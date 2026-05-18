import { cn } from "@client/lib/utils";
import type { JSX } from "react";

export type IndicatorChipEntry = {
  id: string;
  displayName: string;
  /** Swatch color — typically the first entry of the plugin's renderConfig.palette. */
  swatch: string;
};

export type ControlsLayout = "top-chips" | "sidebar-right" | "sidebar-left";

function IndicatorChip(props: {
  entry: IndicatorChipEntry;
  visible: boolean;
  onToggle(id: string, visible: boolean): void;
}): JSX.Element {
  const { entry: e, visible } = props;
  return (
    // biome-ignore lint/a11y/useSemanticElements: chip toggle requires role=checkbox on a styled button — input[checkbox] cannot carry the swatch+label chip design
    <button
      key={e.id}
      type="button"
      role="checkbox"
      aria-checked={visible}
      aria-label={e.displayName}
      data-testid={`indicator-chip-${e.id}`}
      onClick={() => props.onToggle(e.id, !visible)}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded border transition-colors",
        visible
          ? "border-foreground bg-muted text-foreground"
          : "border-border text-muted-foreground",
      )}
    >
      <span className="inline-block size-2 rounded-full" style={{ background: e.swatch }} />
      {e.displayName}
    </button>
  );
}

export function IndicatorControlPanel(props: {
  entries: IndicatorChipEntry[];
  visibility: Record<string, boolean>;
  onToggle: (id: string, visible: boolean) => void;
  onShowAll(): void;
  onShowNone(): void;
  layout: ControlsLayout;
}): JSX.Element {
  const isSidebar = props.layout !== "top-chips";
  return (
    <div
      data-testid="indicator-control-panel"
      className={cn("flex gap-1.5 flex-wrap p-1.5", isSidebar && "flex-col")}
    >
      <button
        type="button"
        onClick={props.onShowAll}
        className="text-xs px-2 py-0.5 rounded border border-border hover:bg-muted"
      >
        All
      </button>
      <button
        type="button"
        onClick={props.onShowNone}
        className="text-xs px-2 py-0.5 rounded border border-border hover:bg-muted"
      >
        None
      </button>
      {props.entries.map((e) => (
        <IndicatorChip
          key={e.id}
          entry={e}
          visible={props.visibility[e.id] ?? false}
          onToggle={props.onToggle}
        />
      ))}
    </div>
  );
}
