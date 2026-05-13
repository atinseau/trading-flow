import { Badge } from "@client/components/ui/badge";
import { Button } from "@client/components/ui/button";
import { ApiError, api } from "@client/lib/api";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Rocket } from "lucide-react";
import { useState } from "react";
import type { ReplayEventRow } from "./replay-types";

/**
 * Renders a `FeedbackLessonProposed` event as a card. Shows the
 * proposed action (CREATE / REINFORCE / REFINE / DEPRECATE), the
 * lesson text, and the rationale.
 *
 * The "Promouvoir en prod" button materializes the proposal into the
 * live `lessons` / `lesson_events` tables via
 * `POST /api/replay/sessions/:id/events/:eventId/promote`. The
 * endpoint is idempotent — clicking twice returns the existing
 * lessonId. CREATE proposals land as PENDING ; the standard
 * /lessons/:id/approve flow then activates them.
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

export function FeedbackAnalysisCard({
  event,
  sessionId,
}: {
  event: ReplayEventRow;
  sessionId: string;
}) {
  const [promotedLessonId, setPromotedLessonId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const promote = useMutation({
    mutationFn: () =>
      api<{ ok: true; lessonId: string | null; action: string; alreadyPromoted?: boolean }>(
        `/api/replay/sessions/${sessionId}/events/${event.id}/promote`,
        { method: "POST" },
      ),
    onSuccess: (res) => {
      setPromotedLessonId(res.lessonId);
      setError(null);
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string } | null;
        setError(body?.error ?? e.message);
      } else {
        setError((e as Error).message);
      }
    },
  });

  if (event.type !== "FeedbackLessonProposed") return null;
  const payload = event.payload as { data: ProposedPayload };
  const d = payload.data;
  const promoted = promotedLessonId !== null;

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
          {promoted ? "PROMUE" : "PROPOSITION — NEUTRALISÉE"}
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

      <div className="flex items-center gap-2 pt-1">
        {promoted ? (
          <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            Promue en prod
            {promotedLessonId && (
              <span className="font-mono opacity-70">— {promotedLessonId.slice(0, 8)}</span>
            )}
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={promote.isPending}
            onClick={() => promote.mutate()}
            title="Matérialise cette proposition dans la table lessons live (PENDING ; à approuver ensuite)"
          >
            {promote.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Rocket className="size-3.5" />
            )}
            Promouvoir en prod
          </Button>
        )}
        {error && <span className="text-[11px] text-red-400">Erreur : {error}</span>}
      </div>
    </div>
  );
}
