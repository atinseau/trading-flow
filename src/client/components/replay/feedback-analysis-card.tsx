import { Badge } from "@client/components/ui/badge";
import type { ReplayEventRow } from "./replay-types";

/**
 * Renders a `FeedbackLessonProposed` event as a card. Shows the
 * proposed action (CREATE / REINFORCE / REFINE / DEPRECATE), the
 * lesson text, and the rationale. The "NEUTRALISÉ" badge makes it
 * unambiguous : these proposals are NOT promoted to the live
 * `lessons` table — they live only in `replay_events`.
 *
 * The actual "Promouvoir en prod" button is a future J3 follow-up ; for
 * now this card is read-only and serves to let the user inspect what
 * the feedback loop would have proposed.
 */
type ProposedPayload = {
  action: "CREATE" | "REINFORCE" | "REFINE" | "DEPRECATE";
  title: string;
  body: string;
  rationale: string;
  sourceTradeSetupId: string;
  supersedesLessonId?: string;
};

const ACTION_BADGE: Record<ProposedPayload["action"], string> = {
  CREATE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  REINFORCE: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  REFINE: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  DEPRECATE: "bg-red-500/15 text-red-300 border-red-500/30",
};

export function FeedbackAnalysisCard({ event }: { event: ReplayEventRow }) {
  if (event.type !== "FeedbackLessonProposed") return null;
  const payload = event.payload as { data: ProposedPayload };
  const d = payload.data;

  return (
    <div className="rounded-md border border-dashed border-border bg-card p-3 space-y-2 text-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-[10px] uppercase ${ACTION_BADGE[d.action]}`}>
            {d.action}
          </Badge>
          <div className="text-[10px] text-muted-foreground font-mono">
            setup {d.sourceTradeSetupId.slice(0, 8)}
          </div>
        </div>
        <Badge
          variant="outline"
          className="text-[10px] text-muted-foreground border-muted-foreground/40"
        >
          PROPOSITION — NEUTRALISÉE
        </Badge>
      </div>

      <div className="font-semibold leading-snug">{d.title}</div>

      <div className="text-xs whitespace-pre-wrap text-muted-foreground border-l-2 border-primary/30 pl-3">
        {d.body}
      </div>

      <div className="text-[11px] text-muted-foreground italic">
        <span className="font-semibold not-italic">Rationale :</span> {d.rationale}
      </div>

      {d.supersedesLessonId && (
        <div className="text-[10px] text-muted-foreground font-mono">
          Supersedes lesson : {d.supersedesLessonId.slice(0, 8)}
        </div>
      )}
    </div>
  );
}
