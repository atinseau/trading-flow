import { describe, expect, test } from "bun:test";
import { pickLiveStatus } from "@client/components/replay/pickLiveStatus";
import type { ReplaySessionStatus } from "@client/components/replay/replay-types";

/**
 * Truth-table for the DB-vs-workflow-state status reconciliation.
 *
 * Each row asserts which of the two sources wins. The lag bug we're guarding
 * against is "user clicks Pause, workflow flips to PAUSED, DB row stays
 * READY until a fire-and-forget activity lands" → UI must show PAUSED
 * immediately.
 */

describe("pickLiveStatus", () => {
  test("live wins when set to a valid status (DB stale)", () => {
    expect(pickLiveStatus("READY", "PAUSED")).toBe("PAUSED");
    expect(pickLiveStatus("PAUSED", "READY")).toBe("READY");
    expect(pickLiveStatus("READY", "COST_CAPPED")).toBe("COST_CAPPED");
  });

  test("DB fallback when live is null (workflow terminated or not started)", () => {
    expect(pickLiveStatus("COMPLETED", null)).toBe("COMPLETED");
    expect(pickLiveStatus("FAILED", null)).toBe("FAILED");
    expect(pickLiveStatus("READY", null)).toBe("READY");
  });

  test("DB fallback when live is undefined (loading / missing)", () => {
    expect(pickLiveStatus("READY", undefined)).toBe("READY");
    expect(pickLiveStatus("PAUSED", undefined)).toBe("PAUSED");
  });

  test("DB fallback when live is structurally invalid", () => {
    // Caller might forward a stale type cast or a server-side typo. We
    // prefer the validated DB value over a junk live value.
    expect(pickLiveStatus("READY", "BOGUS" as ReplaySessionStatus)).toBe("READY");
    expect(pickLiveStatus("READY", "" as ReplaySessionStatus)).toBe("READY");
  });

  test("agreement between live and DB returns the same value", () => {
    expect(pickLiveStatus("READY", "READY")).toBe("READY");
    expect(pickLiveStatus("PAUSED", "PAUSED")).toBe("PAUSED");
  });
});
