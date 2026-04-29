import { describe, expect, test } from "bun:test";
import { deriveOutcome, type EventTypeLite } from "@domain/services/deriveOutcome";

const ev = (type: string, sequence = 1): EventTypeLite => ({ type, sequence });

describe("deriveOutcome", () => {
  test("active setup (CANDIDATE) returns null", () => {
    expect(deriveOutcome("CANDIDATE", [ev("SetupCreated")])).toBeNull();
  });

  test("active setup (TRACKING) returns null", () => {
    expect(deriveOutcome("TRACKING", [ev("SetupCreated"), ev("Confirmed", 2)])).toBeNull();
  });

  test("REJECTED status -> REJECTED", () => {
    expect(deriveOutcome("REJECTED", [ev("SetupCreated"), ev("Rejected", 2)])).toBe("REJECTED");
  });

  test("INVALIDATED before any Confirmed/EntryFilled -> INVALIDATED_PRE_TRADE", () => {
    expect(deriveOutcome("INVALIDATED", [ev("SetupCreated"), ev("Invalidated", 2)])).toBe(
      "INVALIDATED_PRE_TRADE",
    );
  });

  test("INVALIDATED after EntryFilled -> INVALIDATED_POST_TRADE", () => {
    expect(
      deriveOutcome("INVALIDATED", [
        ev("SetupCreated"),
        ev("Confirmed", 2),
        ev("EntryFilled", 3),
        ev("PriceInvalidated", 4),
      ]),
    ).toBe("INVALIDATED_POST_TRADE");
  });

  test("EXPIRED without Confirmed -> INVALIDATED_PRE_TRADE", () => {
    expect(
      deriveOutcome("EXPIRED", [ev("SetupCreated"), ev("Weakened", 2), ev("Expired", 3)]),
    ).toBe("INVALIDATED_PRE_TRADE");
  });

  test("EXPIRED with Confirmed but no EntryFilled -> EXPIRED_NO_FILL", () => {
    expect(
      deriveOutcome("EXPIRED", [ev("SetupCreated"), ev("Confirmed", 2), ev("Expired", 3)]),
    ).toBe("EXPIRED_NO_FILL");
  });

  test("EXPIRED with EntryFilled, no TP/SL -> TIME_OUT", () => {
    expect(
      deriveOutcome("EXPIRED", [
        ev("SetupCreated"),
        ev("Confirmed", 2),
        ev("EntryFilled", 3),
        ev("Expired", 4),
      ]),
    ).toBe("TIME_OUT");
  });

  test("EXPIRED with EntryFilled and TPHit -> WIN", () => {
    expect(
      deriveOutcome("EXPIRED", [
        ev("SetupCreated"),
        ev("Confirmed", 2),
        ev("EntryFilled", 3),
        ev("TPHit", 4),
        ev("Expired", 5),
      ]),
    ).toBe("WIN");
  });

  test("CLOSED with TPHit only -> WIN", () => {
    expect(
      deriveOutcome("CLOSED", [
        ev("SetupCreated"),
        ev("Confirmed", 2),
        ev("EntryFilled", 3),
        ev("TPHit", 4),
      ]),
    ).toBe("WIN");
  });

  test("CLOSED with SLHit only -> LOSS", () => {
    expect(
      deriveOutcome("CLOSED", [
        ev("SetupCreated"),
        ev("Confirmed", 2),
        ev("EntryFilled", 3),
        ev("SLHit", 4),
      ]),
    ).toBe("LOSS");
  });

  test("CLOSED with TPHit then SLHit -> PARTIAL_WIN", () => {
    expect(
      deriveOutcome("CLOSED", [
        ev("SetupCreated"),
        ev("Confirmed", 2),
        ev("EntryFilled", 3),
        ev("TPHit", 4),
        ev("TrailingMoved", 5),
        ev("SLHit", 6),
      ]),
    ).toBe("PARTIAL_WIN");
  });

  test("CLOSED with no TP/SL -> TIME_OUT", () => {
    expect(
      deriveOutcome("CLOSED", [ev("SetupCreated"), ev("Confirmed", 2), ev("EntryFilled", 3)]),
    ).toBe("TIME_OUT");
  });
});
