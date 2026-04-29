import { buildLessonApprovalUseCase } from "@domain/feedback/lessonApprovalUseCase";
import { describe, expect, test } from "bun:test";
import { InMemoryLessonEventStore } from "../../fakes/InMemoryLessonEventStore";
import { InMemoryLessonStore } from "../../fakes/InMemoryLessonStore";

const lessonId = "11111111-1111-1111-1111-111111111111";

function setup() {
  const store = new InMemoryLessonStore();
  const eventStore = new InMemoryLessonEventStore();
  const captured: { msgId: number; finalState: string; atIso: string; chatId: string }[] = [];
  const useCase = buildLessonApprovalUseCase({
    lessonStore: store,
    lessonEventStore: eventStore,
    editLessonMessage: async (args) => {
      captured.push(args);
    },
    chatId: "1",
    notificationMsgIdByLessonId: async (id) => (id === lessonId ? 42 : null),
    clock: {
      now: () => new Date("2026-04-29T10:00:00Z"),
      candleDurationMs: () => 0,
    },
  });
  return { store, eventStore, useCase, captured };
}

describe("lessonApprovalUseCase", () => {
  test("approve transitions PENDING → ACTIVE and edits message", async () => {
    const { store, useCase, captured } = setup();
    await store.create({
      id: lessonId,
      watchId: "btc-1h",
      category: "reviewing",
      title: "x".repeat(20),
      body: "y".repeat(60),
      rationale: "z".repeat(30),
      promptVersion: "feedback_v1",
      status: "PENDING",
    });
    await useCase.handle({ action: "approve", lessonId });
    const after = await store.getById(lessonId);
    expect(after?.status).toBe("ACTIVE");
    expect(captured).toEqual([
      { msgId: 42, finalState: "approved", atIso: "2026-04-29T10:00:00.000Z", chatId: "1" },
    ]);
  });

  test("reject transitions PENDING → REJECTED and edits message", async () => {
    const { store, useCase } = setup();
    await store.create({
      id: lessonId,
      watchId: "btc-1h",
      category: "reviewing",
      title: "x".repeat(20),
      body: "y".repeat(60),
      rationale: "z".repeat(30),
      promptVersion: "feedback_v1",
      status: "PENDING",
    });
    await useCase.handle({ action: "reject", lessonId });
    const after = await store.getById(lessonId);
    expect(after?.status).toBe("REJECTED");
  });

  test("REFINE approve archives the supersedes lesson", async () => {
    const { store, useCase } = setup();
    const oldId = "00000000-0000-0000-0000-000000000099";
    await store.create({
      id: oldId,
      watchId: "btc-1h",
      category: "reviewing",
      title: "x".repeat(20),
      body: "y".repeat(60),
      rationale: "z".repeat(30),
      promptVersion: "feedback_v1",
      status: "ACTIVE",
    });
    await store.create({
      id: lessonId,
      watchId: "btc-1h",
      category: "reviewing",
      title: "x".repeat(20),
      body: "y".repeat(60),
      rationale: "z".repeat(30),
      promptVersion: "feedback_v1",
      status: "PENDING",
      supersedesLessonId: oldId,
    });
    await useCase.handle({ action: "approve", lessonId });
    const oldAfter = await store.getById(oldId);
    expect(oldAfter?.status).toBe("ARCHIVED");
  });

  test("idempotent: second approve is a no-op", async () => {
    const { store, eventStore, useCase } = setup();
    await store.create({
      id: lessonId,
      watchId: "btc-1h",
      category: "reviewing",
      title: "x".repeat(20),
      body: "y".repeat(60),
      rationale: "z".repeat(30),
      promptVersion: "feedback_v1",
      status: "PENDING",
    });
    await useCase.handle({ action: "approve", lessonId });
    await useCase.handle({ action: "approve", lessonId });
    const events = await eventStore.listForLesson(lessonId);
    const approvals = events.filter((e) => e.type === "HumanApproved");
    expect(approvals).toHaveLength(1);
  });
});
