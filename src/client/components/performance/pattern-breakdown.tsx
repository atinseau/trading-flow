import { Skeleton } from "@client/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@client/components/ui/table";
import type { PatternRow } from "./perf-types";

export function PatternBreakdown({ data, loading }: { data?: PatternRow[]; loading?: boolean }) {
  if (loading) return <Skeleton className="h-[200px]" />;
  if (!data || data.length === 0) {
    return (
      <div className="h-[200px] grid place-items-center rounded-md border bg-card text-sm text-muted-foreground">
        Aucun pattern à analyser sur la période.
      </div>
    );
  }
  return (
    <div className="rounded-md border bg-card overflow-hidden">
      <div className="px-3 py-2 border-b">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
          Performance par pattern × direction
        </h3>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Pattern</TableHead>
            <TableHead className="text-xs">Dir</TableHead>
            <TableHead className="text-xs text-right">Trades</TableHead>
            <TableHead className="text-xs text-right">Total R</TableHead>
            <TableHead className="text-xs text-right">Win rate</TableHead>
            <TableHead className="text-xs text-right">PF</TableHead>
            <TableHead className="text-xs">Verdict</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const pf = row.profitFactor;
            const verdict =
              pf === null
                ? "—"
                : pf >= 2
                  ? "⭐ excellent"
                  : pf >= 1.5
                    ? "✓ solide"
                    : pf >= 1
                      ? "≈ marginal"
                      : "⚠️ à drop";
            const tone =
              row.totalR > 0
                ? "text-emerald-400"
                : row.totalR < 0
                  ? "text-red-400"
                  : "text-muted-foreground";
            return (
              <TableRow key={`${row.pattern}-${row.direction}`}>
                <TableCell className="font-mono text-xs">{row.pattern}</TableCell>
                <TableCell className="text-xs">{row.direction}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {row.trades}
                </TableCell>
                <TableCell className={`text-right font-mono text-xs tabular-nums ${tone}`}>
                  {row.totalR > 0 ? "+" : ""}
                  {row.totalR.toFixed(2)}R
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {row.winRate === null ? "—" : `${(row.winRate * 100).toFixed(0)}%`}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {pf === null ? "—" : pf.toFixed(2)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{verdict}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
