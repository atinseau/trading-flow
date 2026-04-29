import { z } from "zod";

export const LessonCategorySchema = z.enum(["detecting", "reviewing", "finalizing"]);

const CreateActionSchema = z.object({
  type: z.literal("CREATE"),
  category: LessonCategorySchema,
  title: z.string().min(10).max(120),
  body: z.string().min(40).max(800),
  rationale: z.string().min(20).max(500),
});

const ReinforceActionSchema = z.object({
  type: z.literal("REINFORCE"),
  lessonId: z.guid(),
  reason: z.string().min(10).max(500),
});

const RefineActionSchema = z.object({
  type: z.literal("REFINE"),
  lessonId: z.guid(),
  newTitle: z.string().min(10).max(120),
  newBody: z.string().min(40).max(800),
  rationale: z.string().min(20).max(500),
});

const DeprecateActionSchema = z.object({
  type: z.literal("DEPRECATE"),
  lessonId: z.guid(),
  reason: z.string().min(10).max(500),
});

export const FeedbackActionSchema = z.discriminatedUnion("type", [
  CreateActionSchema,
  ReinforceActionSchema,
  RefineActionSchema,
  DeprecateActionSchema,
]);

export const FeedbackOutputSchema = z.object({
  summary: z.string().min(20).max(2000),
  actions: z.array(FeedbackActionSchema).max(5),
});

export type FeedbackOutput = z.infer<typeof FeedbackOutputSchema>;
export type FeedbackAction = z.infer<typeof FeedbackActionSchema>;

// Lesson event payload union (persisted in lesson_events.payload jsonb)
const CreatePayloadSchema = z.object({
  category: LessonCategorySchema,
  title: z.string(),
  body: z.string(),
  rationale: z.string(),
});

const ReinforcePayloadSchema = z.object({
  reason: z.string(),
});

const RefinePayloadSchema = z.object({
  supersedesLessonId: z.guid(),
  before: z.object({ title: z.string(), body: z.string() }),
  after: z.object({ title: z.string(), body: z.string() }),
  rationale: z.string(),
});

const DeprecatePayloadSchema = z.object({
  reason: z.string(),
});

const AutoRejectedPayloadSchema = z.object({
  proposedAction: FeedbackActionSchema,
  reason: z.enum([
    "cap_exceeded",
    "pinned_lesson",
    "asset_mention",
    "timeframe_mention",
    "lesson_not_found",
    "lesson_not_active",
  ]),
});

const NotificationSentPayloadSchema = z.object({
  channel: z.literal("telegram"),
  msgId: z.number().int(),
});

const HumanApprovedPayloadSchema = z.object({
  via: z.enum(["telegram", "cli"]),
  byUser: z.string().optional(),
});

const HumanRejectedPayloadSchema = z.object({
  via: z.enum(["telegram", "cli"]),
  reason: z.string().optional(),
});

const HumanPinnedPayloadSchema = z.object({ via: z.literal("cli"), reason: z.string().optional() });
const HumanUnpinnedPayloadSchema = z.object({
  via: z.literal("cli"),
  reason: z.string().optional(),
});
const HumanArchivedPayloadSchema = z.object({
  via: z.literal("cli"),
  reason: z.string().optional(),
});

export const LessonEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("CREATE"), data: CreatePayloadSchema }),
  z.object({ type: z.literal("REINFORCE"), data: ReinforcePayloadSchema }),
  z.object({ type: z.literal("REFINE"), data: RefinePayloadSchema }),
  z.object({ type: z.literal("DEPRECATE"), data: DeprecatePayloadSchema }),
  z.object({ type: z.literal("AutoRejected"), data: AutoRejectedPayloadSchema }),
  z.object({ type: z.literal("NotificationSent"), data: NotificationSentPayloadSchema }),
  z.object({ type: z.literal("HumanApproved"), data: HumanApprovedPayloadSchema }),
  z.object({ type: z.literal("HumanRejected"), data: HumanRejectedPayloadSchema }),
  z.object({ type: z.literal("HumanPinned"), data: HumanPinnedPayloadSchema }),
  z.object({ type: z.literal("HumanUnpinned"), data: HumanUnpinnedPayloadSchema }),
  z.object({ type: z.literal("HumanArchived"), data: HumanArchivedPayloadSchema }),
]);

export type LessonEventPayload = z.infer<typeof LessonEventPayloadSchema>;
export type LessonEventType = LessonEventPayload["type"];
