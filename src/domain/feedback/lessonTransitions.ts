import type { LessonStatus } from "@domain/feedback/lessonAction";

const ALLOWED: Record<LessonStatus, ReadonlySet<LessonStatus>> = {
  PENDING: new Set(["ACTIVE", "REJECTED"]),
  ACTIVE: new Set(["ARCHIVED", "DEPRECATED"]),
  REJECTED: new Set(),
  DEPRECATED: new Set(),
  ARCHIVED: new Set(),
};

export function canTransition(from: LessonStatus, to: LessonStatus): boolean {
  return ALLOWED[from].has(to);
}

export function isAutoActionAllowed(args: {
  pinned: boolean;
  action: "REINFORCE" | "REFINE" | "DEPRECATE";
}): boolean {
  if (!args.pinned) return true;
  return args.action === "REINFORCE";
}
