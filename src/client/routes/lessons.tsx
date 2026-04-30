import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { type Lesson, LessonCard } from "../components/lessons/lesson-card";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

type LessonStatus = "PENDING" | "ACTIVE" | "REJECTED" | "DEPRECATED" | "ARCHIVED";

const PILLS: { id: LessonStatus | "all"; label: string }[] = [
  { id: "PENDING", label: "En attente" },
  { id: "ACTIVE", label: "Actives" },
  { id: "all", label: "Toutes" },
  { id: "DEPRECATED", label: "Dépréciées" },
  { id: "REJECTED", label: "Rejetées" },
  { id: "ARCHIVED", label: "Archivées" },
];

export function Component() {
  const [status, setStatus] = useState<LessonStatus | "all">("PENDING");

  const lessons = useQuery({
    queryKey: ["lessons", "global", { status }],
    queryFn: () => api<Lesson[]>(`/api/lessons${status === "all" ? "" : `?status=${status}`}`),
    staleTime: 5_000,
  });

  // Group by watchId for clarity.
  const grouped = new Map<string, Lesson[]>();
  for (const l of lessons.data ?? []) {
    const arr = grouped.get(l.watchId) ?? [];
    arr.push(l);
    grouped.set(l.watchId, arr);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Leçons</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Vue globale de toutes les leçons générées par le feedback loop, toutes watches confondues.
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {PILLS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setStatus(p.id)}
            className={cn(
              "px-3 py-1 rounded-full text-xs border transition-colors",
              status === p.id
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border hover:bg-card",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {lessons.isLoading && <div className="text-sm text-muted-foreground">Chargement…</div>}
      {lessons.data && lessons.data.length === 0 && !lessons.isLoading && (
        <div className="border border-dashed rounded-lg p-12 text-center text-sm text-muted-foreground">
          Aucune leçon pour ce filtre.
        </div>
      )}

      {[...grouped.entries()].map(([watchId, list]) => (
        <section key={watchId} className="space-y-3">
          <Link
            to={`/watches/${watchId}`}
            className="text-xs font-mono uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            {watchId} ({list.length})
          </Link>
          <div className="space-y-3">
            {list.map((l) => (
              <LessonCard key={l.id} lesson={l} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
