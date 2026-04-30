import { Archive, Check, Pin, PinOff, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useLessonAction } from "../../hooks/useLessonAction";
import { fmtRelative } from "../../lib/format";
import { cn } from "../../lib/utils";
import { ConfirmAction } from "../shared/confirm-action";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";

export type Lesson = {
  id: string;
  watchId: string;
  category: "detecting" | "reviewing" | "finalizing";
  status: "PENDING" | "ACTIVE" | "REJECTED" | "DEPRECATED" | "ARCHIVED";
  title: string;
  body: string;
  rationale: string;
  pinned: boolean;
  timesReinforced: number;
  timesUsedInPrompts: number;
  sourceFeedbackEventId: string | null;
  supersedesLessonId: string | null;
  createdAt: string;
  activatedAt: string | null;
  deprecatedAt: string | null;
  promptVersion: string;
};

const STATUS_BADGE: Record<Lesson["status"], string> = {
  PENDING: "border-amber-500/40 text-amber-400 bg-amber-500/10",
  ACTIVE: "border-emerald-500/40 text-emerald-400 bg-emerald-500/10",
  REJECTED: "border-zinc-500/40 text-zinc-400",
  DEPRECATED: "border-zinc-500/40 text-zinc-400",
  ARCHIVED: "border-zinc-500/40 text-zinc-500",
};

const CATEGORY_LABEL: Record<Lesson["category"], string> = {
  detecting: "Detection",
  reviewing: "Review",
  finalizing: "Finalize",
};

export function LessonCard({ lesson, showSetupLink }: { lesson: Lesson; showSetupLink?: boolean }) {
  const { approve, reject, pin, unpin, archive } = useLessonAction();
  const isPending = lesson.status === "PENDING";
  const isActive = lesson.status === "ACTIVE";

  return (
    <Card className={cn(lesson.pinned && "border-primary/40")}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {lesson.pinned && <Pin className="size-3.5 text-primary" />}
            <Badge variant="outline" className="text-[10px] uppercase">
              {CATEGORY_LABEL[lesson.category]}
            </Badge>
            <Badge
              variant="outline"
              className={cn("text-[10px] uppercase", STATUS_BADGE[lesson.status])}
            >
              {lesson.status}
            </Badge>
            <span className="text-xs text-muted-foreground font-mono">
              ×{lesson.timesReinforced} reinforced · ×{lesson.timesUsedInPrompts} used
            </span>
          </div>
          <span className="text-xs text-muted-foreground">{fmtRelative(lesson.createdAt)}</span>
        </div>

        <h3 className="font-semibold leading-snug">{lesson.title}</h3>
        <p className="text-sm text-muted-foreground whitespace-pre-wrap">{lesson.body}</p>

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">Voir le rationale</summary>
          <p className="mt-2 whitespace-pre-wrap">{lesson.rationale}</p>
          {lesson.supersedesLessonId && (
            <p className="mt-2">
              Remplace :{" "}
              <Link
                to={`#lesson-${lesson.supersedesLessonId}`}
                className="font-mono hover:text-foreground"
              >
                {lesson.supersedesLessonId.slice(0, 8)}
              </Link>
            </p>
          )}
          {showSetupLink && lesson.sourceFeedbackEventId && (
            <p className="mt-1 font-mono">
              source event {lesson.sourceFeedbackEventId.slice(0, 8)}
            </p>
          )}
        </details>

        <div className="flex gap-2 flex-wrap pt-1">
          {isPending && (
            <>
              <Button
                size="sm"
                onClick={() => approve.mutate({ lessonId: lesson.id })}
                disabled={approve.isPending}
              >
                <Check className="size-3.5" /> Approuver
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => reject.mutate({ lessonId: lesson.id })}
                disabled={reject.isPending}
              >
                <X className="size-3.5" /> Rejeter
              </Button>
            </>
          )}
          {isActive && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  lesson.pinned
                    ? unpin.mutate({ lessonId: lesson.id })
                    : pin.mutate({ lessonId: lesson.id })
                }
                disabled={pin.isPending || unpin.isPending}
              >
                {lesson.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                {lesson.pinned ? "Désépingler" : "Épingler"}
              </Button>
              <ConfirmAction
                title="Archiver cette leçon ?"
                description="La leçon ne sera plus injectée dans les prompts. L'historique reste en DB."
                trigger={
                  <Button size="sm" variant="outline">
                    <Archive className="size-3.5" /> Archiver
                  </Button>
                }
                onConfirm={() => archive.mutate({ lessonId: lesson.id })}
              />
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
