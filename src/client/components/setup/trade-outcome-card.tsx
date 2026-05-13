import { Badge } from "@client/components/ui/badge";

export type TradeOutcomeFields = {
  direction: "LONG" | "SHORT" | null;
  entryPrice: string | null;
  stopLoss: string | null;
  exitPrice: string | null;
  exitReason: string | null;
  pnlPct: string | null;
  rMultiple: string | null;
  closedAt: string | null;
  outcome: string | null;
};

const REASON_LABEL: Record<string, string> = {
  TP_HIT: "TP touché",
  SL_HIT: "SL touché",
  INVALIDATED: "Invalidé post-trade",
  TTL_EXPIRED: "TTL expiré",
  KILLED: "Tué manuellement",
};

export function TradeOutcomeCard({ s }: { s: TradeOutcomeFields }) {
  // Only render when we actually have a trade with computed metrics. For
  // setups that never reached EntryFilled (REJECTED, INVALIDATED_PRE_TRADE,
  // ...), this card has nothing to show — render null and let the page
  // continue with status badges only.
  if (s.rMultiple === null || s.entryPrice === null || s.exitPrice === null) {
    return null;
  }

  const r = Number(s.rMultiple);
  const pnl = Number(s.pnlPct ?? 0);
  const tone = r > 0 ? "text-emerald-400" : r < 0 ? "text-red-400" : "text-muted-foreground";

  return (
    <div className="rounded-md border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Trade outcome</h3>
        {s.exitReason && (
          <Badge variant="outline" className="text-[10px]">
            {REASON_LABEL[s.exitReason] ?? s.exitReason}
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
        <Field label="Direction" value={s.direction ?? "—"} mono />
        <Field
          label="Entry"
          value={s.entryPrice !== null ? Number(s.entryPrice).toString() : "—"}
          mono
        />
        <Field label="SL" value={s.stopLoss !== null ? Number(s.stopLoss).toString() : "—"} mono />
        <Field
          label="Exit"
          value={s.exitPrice !== null ? Number(s.exitPrice).toString() : "—"}
          mono
        />
        <Field label="PnL %" value={`${pnl > 0 ? "+" : ""}${pnl.toFixed(2)}%`} mono tone={tone} />
        <Field label="R-multiple" value={`${r > 0 ? "+" : ""}${r.toFixed(2)}R`} mono tone={tone} />
        {s.closedAt && (
          <Field label="Fermé" value={new Date(s.closedAt).toLocaleString()} mono={false} />
        )}
        {s.outcome && <Field label="Outcome" value={s.outcome} mono />}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  tone?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`text-sm ${mono ? "font-mono tabular-nums" : ""} ${tone ?? "text-foreground"}`}
      >
        {value}
      </div>
    </div>
  );
}
