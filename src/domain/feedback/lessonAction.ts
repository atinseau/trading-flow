export type LessonCategory = "detecting" | "reviewing" | "finalizing";

export type LessonStatus = "PENDING" | "ACTIVE" | "REJECTED" | "DEPRECATED" | "ARCHIVED";

export type CreateLessonAction = {
  type: "CREATE";
  category: LessonCategory;
  title: string;
  body: string;
  rationale: string;
};

export type ReinforceLessonAction = {
  type: "REINFORCE";
  lessonId: string;
  reason: string;
};

export type RefineLessonAction = {
  type: "REFINE";
  lessonId: string;
  newTitle: string;
  newBody: string;
  rationale: string;
};

export type DeprecateLessonAction = {
  type: "DEPRECATE";
  lessonId: string;
  reason: string;
};

export type LessonAction =
  | CreateLessonAction
  | ReinforceLessonAction
  | RefineLessonAction
  | DeprecateLessonAction;

export type AutoRejectReason =
  | "cap_exceeded"
  | "pinned_lesson"
  | "asset_mention"
  | "timeframe_mention"
  | "lesson_not_found"
  | "lesson_not_active";
