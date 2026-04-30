import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";

export type GlobalLessonCounts = {
  PENDING: number;
  ACTIVE: number;
  REJECTED: number;
  DEPRECATED: number;
  ARCHIVED: number;
  total: number;
};

export function useLessonCounts() {
  return useQuery({
    queryKey: ["lesson-counts", "global"],
    queryFn: () => api<GlobalLessonCounts>("/api/lessons/counts"),
    staleTime: 30_000,
  });
}
