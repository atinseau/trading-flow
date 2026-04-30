import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { type Lesson, LessonCard } from "./lesson-card";

type LessonStatus = "PENDING" | "ACTIVE" | "REJECTED" | "DEPRECATED" | "ARCHIVED";
type LessonCategory = "detecting" | "reviewing" | "finalizing";

type Counts = Record<LessonStatus, number> & { pinned: number; total: number };

const STATUS_PILLS: { id: LessonStatus | "all"; label: string }[] = [
  { id: "all", label: "Toutes" },
  { id: "PENDING", label: "En attente" },
  { id: "ACTIVE", label: "Actives" },
  { id: "DEPRECATED", label: "Dépréciées" },
  { id: "REJECTED", label: "Rejetées" },
  { id: "ARCHIVED", label: "Archivées" },
];

const CATEGORY_PILLS: { id: LessonCategory | "all"; label: string }[] = [
  { id: "all", label: "Toutes catégories" },
  { id: "detecting", label: "Detection" },
  { id: "reviewing", label: "Review" },
  { id: "finalizing", label: "Finalize" },
];

export function LessonsSection({ watchId }: { watchId: string }) {
  const [status, setStatus] = useState<LessonStatus | "all">("all");
  const [category, setCategory] = useState<LessonCategory | "all">("all");

  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (category !== "all") params.set("category", category);
  const qs = params.toString();

  const lessons = useQuery({
    queryKey: ["lessons", { watchId, status, category }],
    queryFn: () => api<Lesson[]>(`/api/watches/${watchId}/lessons${qs ? `?${qs}` : ""}`),
    staleTime: 5_000,
  });

  const counts = useQuery({
    queryKey: ["lesson-counts", { watchId }],
    queryFn: () => api<Counts>(`/api/watches/${watchId}/lessons/counts`),
    staleTime: 30_000,
  });

  const c = counts.data;

  return (
    <div className="space-y-4">
      {c && (
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground font-mono border-b border-border pb-3">
          <span>{c.total} total</span>
          <span>·</span>
          {c.PENDING > 0 && (
            <>
              <span className="text-amber-400">{c.PENDING} en attente</span>
              <span>·</span>
            </>
          )}
          <span className="text-emerald-400">{c.ACTIVE} actives</span>
          <span>·</span>
          <span>{c.pinned} épinglées</span>
          <span>·</span>
          <span>{c.DEPRECATED + c.REJECTED + c.ARCHIVED} inactives</span>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          {STATUS_PILLS.map((p) => {
            const active = status === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setStatus(p.id)}
                className={cn(
                  "px-3 py-1 rounded-full text-xs border transition-colors",
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:bg-card",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {CATEGORY_PILLS.map((p) => {
            const active = category === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setCategory(p.id)}
                className={cn(
                  "px-2 py-0.5 rounded-full text-[11px] border transition-colors",
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:bg-card",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {lessons.isLoading && <div className="text-sm text-muted-foreground">Chargement…</div>}
      {lessons.error && (
        <div className="text-sm text-destructive">Erreur : {(lessons.error as Error).message}</div>
      )}
      {lessons.data && lessons.data.length === 0 && !lessons.isLoading && (
        <div className="border border-dashed rounded-lg p-12 text-center text-sm text-muted-foreground">
          Aucune leçon pour ce filtre. Les leçons sont générées par le feedback loop quand un setup
          se clôture.
        </div>
      )}
      {lessons.data && lessons.data.length > 0 && (
        <div className="space-y-3">
          {lessons.data.map((l) => (
            <LessonCard key={l.id} lesson={l} />
          ))}
        </div>
      )}
    </div>
  );
}
