import { expect, test } from "bun:test";
import { EventPayloadSchema } from "@domain/events/schemas";

test("SetupCreated payload validates", () => {
  const payload = {
    type: "SetupCreated" as const,
    data: {
      pattern: "double_bottom",
      direction: "LONG" as const,
      keyLevels: { support: 41800, neckline: 43200, target: 45000, invalidation: 41500 },
      initialScore: 25,
      rawObservation: "two clear lows",
    },
  };
  expect(() => EventPayloadSchema.parse(payload)).not.toThrow();
});

test("Strengthened payload validates", () => {
  const payload = {
    type: "Strengthened" as const,
    data: {
      reasoning: "volume confirms",
      observations: [{ kind: "volume_confirmation", text: "1.8x avg" }],
      source: "reviewer_full" as const,
      freshDataSummary: { lastClose: 42850, candlesSinceCreation: 3 },
    },
  };
  expect(() => EventPayloadSchema.parse(payload)).not.toThrow();
});

test("Invalidated payload validates with structure_break reason", () => {
  const payload = {
    type: "Invalidated" as const,
    data: {
      reason: "structure_break",
      trigger: "price_below_invalidation",
      priceAtInvalidation: 41420,
      invalidationLevel: 41500,
      deterministic: true,
    },
  };
  expect(() => EventPayloadSchema.parse(payload)).not.toThrow();
});

test("unknown type rejected", () => {
  expect(() =>
    EventPayloadSchema.parse({
      type: "FooBar",
      data: {},
    }),
  ).toThrow();
});

test("type and data are coupled — wrong data shape rejected", () => {
  expect(() =>
    EventPayloadSchema.parse({
      type: "SetupCreated",
      data: { foo: "bar" },
    }),
  ).toThrow();
});
