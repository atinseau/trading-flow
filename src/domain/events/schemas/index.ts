import { ObservationSchema } from "@domain/schemas/Verdict";
import { z } from "zod";

const KeyLevelsSchema = z.object({
  support: z.number().optional(),
  resistance: z.number().optional(),
  neckline: z.number().optional(),
  target: z.number().optional(),
  invalidation: z.number(),
  entry: z.number().optional(),
});

export const SetupCreatedPayload = z.object({
  pattern: z.string(),
  direction: z.enum(["LONG", "SHORT"]),
  keyLevels: KeyLevelsSchema,
  initialScore: z.number().min(0).max(100),
  rawObservation: z.string(),
});

const FreshDataSummary = z.object({
  lastClose: z.number(),
  candlesSinceCreation: z.number().int().nonnegative(),
});

export const StrengthenedPayload = z.object({
  reasoning: z.string(),
  observations: z.array(ObservationSchema),
  source: z.enum(["reviewer_full", "detector_corroboration"]),
  freshDataSummary: FreshDataSummary.optional(),
});

export const WeakenedPayload = z.object({
  reasoning: z.string(),
  observations: z.array(ObservationSchema),
  freshDataSummary: FreshDataSummary.optional(),
});

export const NeutralPayload = z.object({
  observations: z.array(ObservationSchema),
});

export const InvalidatedPayload = z.object({
  reason: z.string(),
  trigger: z.string(),
  priceAtInvalidation: z.number().optional(),
  invalidationLevel: z.number().optional(),
  deterministic: z.boolean(),
});

export const ConfirmedPayload = z.object({
  decision: z.literal("GO"),
  entry: z.number(),
  stopLoss: z.number(),
  takeProfit: z.array(z.number()).min(1),
  reasoning: z.string(),
  notificationMessageId: z.number().optional(),
});

export const RejectedPayload = z.object({
  decision: z.literal("NO_GO"),
  reasoning: z.string(),
});

export const EntryFilledPayload = z.object({
  fillPrice: z.number(),
  observedAt: z.iso.datetime(),
});

export const TPHitPayload = z.object({
  level: z.number(),
  index: z.number().int().nonnegative(),
  observedAt: z.iso.datetime(),
});

export const SLHitPayload = z.object({
  level: z.number(),
  observedAt: z.iso.datetime(),
});

export const TrailingMovedPayload = z.object({
  newStopLoss: z.number(),
  reason: z.string(),
});

export const ExpiredPayload = z.object({
  reason: z.literal("ttl_reached"),
  ttlExpiresAt: z.iso.datetime(),
});

export const PriceInvalidatedPayload = z.object({
  currentPrice: z.number(),
  invalidationLevel: z.number(),
  observedAt: z.iso.datetime(),
});

export const EventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SetupCreated"), data: SetupCreatedPayload }),
  z.object({ type: z.literal("Strengthened"), data: StrengthenedPayload }),
  z.object({ type: z.literal("Weakened"), data: WeakenedPayload }),
  z.object({ type: z.literal("Neutral"), data: NeutralPayload }),
  z.object({ type: z.literal("Invalidated"), data: InvalidatedPayload }),
  z.object({ type: z.literal("Confirmed"), data: ConfirmedPayload }),
  z.object({ type: z.literal("Rejected"), data: RejectedPayload }),
  z.object({ type: z.literal("EntryFilled"), data: EntryFilledPayload }),
  z.object({ type: z.literal("TPHit"), data: TPHitPayload }),
  z.object({ type: z.literal("SLHit"), data: SLHitPayload }),
  z.object({ type: z.literal("TrailingMoved"), data: TrailingMovedPayload }),
  z.object({ type: z.literal("Expired"), data: ExpiredPayload }),
  z.object({ type: z.literal("PriceInvalidated"), data: PriceInvalidatedPayload }),
]);

export type EventPayload = z.infer<typeof EventPayloadSchema>;
