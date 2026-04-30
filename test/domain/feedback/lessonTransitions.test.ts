import { describe, expect, test } from "bun:test";
import type { LessonStatus } from "@domain/feedback/lessonAction";
import { canTransition, isAutoActionAllowed } from "@domain/feedback/lessonTransitions";

describe("canTransition", () => {
  test("PENDING → ACTIVE is allowed", () => {
    expect(canTransition("PENDING", "ACTIVE")).toBe(true);
  });
  test("PENDING → REJECTED is allowed", () => {
    expect(canTransition("PENDING", "REJECTED")).toBe(true);
  });
  test("ACTIVE → ARCHIVED is allowed", () => {
    expect(canTransition("ACTIVE", "ARCHIVED")).toBe(true);
  });
  test("ACTIVE → DEPRECATED is allowed", () => {
    expect(canTransition("ACTIVE", "DEPRECATED")).toBe(true);
  });
  test("ACTIVE → PENDING is NOT allowed", () => {
    expect(canTransition("ACTIVE", "PENDING")).toBe(false);
  });
  test("REJECTED → ACTIVE is NOT allowed", () => {
    expect(canTransition("REJECTED", "ACTIVE")).toBe(false);
  });
  test("DEPRECATED → ACTIVE is NOT allowed", () => {
    expect(canTransition("DEPRECATED", "ACTIVE")).toBe(false);
  });
  test("ARCHIVED is terminal", () => {
    const terminals: LessonStatus[] = ["ACTIVE", "PENDING", "REJECTED", "DEPRECATED"];
    for (const to of terminals) {
      expect(canTransition("ARCHIVED", to)).toBe(false);
    }
  });
});

describe("isAutoActionAllowed", () => {
  test("REFINE on pinned lesson is NOT allowed", () => {
    expect(isAutoActionAllowed({ pinned: true, action: "REFINE" })).toBe(false);
  });
  test("DEPRECATE on pinned lesson is NOT allowed", () => {
    expect(isAutoActionAllowed({ pinned: true, action: "DEPRECATE" })).toBe(false);
  });
  test("REINFORCE on pinned lesson IS allowed", () => {
    expect(isAutoActionAllowed({ pinned: true, action: "REINFORCE" })).toBe(true);
  });
  test("any action on non-pinned lesson IS allowed", () => {
    for (const action of ["REINFORCE", "REFINE", "DEPRECATE"] as const) {
      expect(isAutoActionAllowed({ pinned: false, action })).toBe(true);
    }
  });
});
