import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { api } from "../../lib/api";
import { type Lesson, LessonCard } from "./lesson-card";

type Response = {
  events: Array<{
    id: string;
    type: string;
    lessonId: string | null;
    occurredAt: string;
  }>;
  lessons: Lesson[];
};

export function SetupLessonsSpotlight({ setupId }: { setupId: string }) {
  const { data } = useQuery({
    queryKey: ["setup-lessons", setupId],
    queryFn: () => api<Response>(`/api/setups/${setupId}/lessons`),
    staleTime: 30_000,
  });

  if (!data || data.lessons.length === 0) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-2">
        <Lightbulb className="size-3.5" />
        Leçons issues de ce setup ({data.lessons.length})
      </h3>
      <div className="space-y-3">
        {data.lessons.map((l) => (
          <LessonCard key={l.id} lesson={l} showSetupLink />
        ))}
      </div>
    </section>
  );
}
