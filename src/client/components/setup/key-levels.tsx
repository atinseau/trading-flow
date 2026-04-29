export function KeyLevels(props: {
  entry?: number | null;
  sl?: number | null;
  tp?: number[];
  invalidation?: number | null;
}) {
  const cell = (label: string, val: number | null | undefined) => (
    <div className="border border-border rounded px-3 py-1.5 font-mono text-xs bg-card">
      <span className="text-[9px] uppercase text-muted-foreground mr-2">{label}</span>
      {val ?? "—"}
    </div>
  );
  return (
    <div className="flex flex-wrap gap-2">
      {cell("Entry", props.entry)}
      {cell("SL", props.sl)}
      {props.tp?.map((p, i) => (
        <div key={i}>{cell(`TP${i + 1}`, p)}</div>
      ))}
      {cell("Invalidation", props.invalidation)}
    </div>
  );
}
