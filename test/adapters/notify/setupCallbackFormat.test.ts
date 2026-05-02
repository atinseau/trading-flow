import { describe, expect, test } from "bun:test";
import { parseCallbackData } from "@adapters/notify/lessonProposalFormat";
import {
  encodeSetupCallback,
  parseSetupCallback,
} from "@adapters/notify/setupCallbackFormat";

describe("setup callback_data encoding", () => {
  const setupId = "11111111-1111-1111-1111-111111111111";

  test("round-trips for kill", () => {
    const enc = encodeSetupCallback({ action: "kill", setupId });
    expect(enc).toBe(`v2|setup|kill|${setupId}`);
    expect(enc.length).toBeLessThanOrEqual(64);
    expect(parseSetupCallback(enc)).toEqual({ action: "kill", setupId });
  });

  test("rejects malformed input", () => {
    expect(parseSetupCallback("malformed")).toBeNull();
    expect(parseSetupCallback("v1|a|11111111-1111-1111-1111-111111111111")).toBeNull();
    expect(parseSetupCallback("v2|setup|kill")).toBeNull();
    expect(parseSetupCallback("v2|setup|kill|not-a-uuid")).toBeNull();
    expect(parseSetupCallback("v2|notsetup|kill|11111111-1111-1111-1111-111111111111")).toBeNull();
    // Unknown actions must not parse — guards future extension safety.
    expect(parseSetupCallback("v2|setup|reset|11111111-1111-1111-1111-111111111111")).toBeNull();
  });

  test("parseSetupCallback returns null for legacy lesson v1 format", () => {
    // Crucial: the notification worker calls parseSetupCallback FIRST and
    // falls back to parseCallbackData. v1 lesson messages already in flight
    // must not be misrouted as setup-kill commands.
    const lessonData = `v1|a|${setupId}`;
    expect(parseSetupCallback(lessonData)).toBeNull();
  });

  test("legacy v1 lesson format still parses via parseCallbackData", () => {
    // Reverse direction: setup-kill callback_data must NOT collide with the
    // legacy lesson parser either.
    const setupData = encodeSetupCallback({ action: "kill", setupId });
    expect(parseCallbackData(setupData)).toBeNull();

    // Sanity: the legacy parser still works for legitimate lesson payloads.
    expect(parseCallbackData(`v1|a|${setupId}`)).toEqual({ action: "approve", lessonId: setupId });
    expect(parseCallbackData(`v1|r|${setupId}`)).toEqual({ action: "reject", lessonId: setupId });
  });
});
