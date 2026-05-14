import { expect } from "bun:test";
import type { CapturedEvent, ExpectedEvent } from "./types";

function sign(n: number): -1 | 0 | 1 {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

/**
 * Asserts that `actual` events match `expected` in chronological order.
 *
 * `expected` is treated as a subset — extra events in `actual` between
 * matches are ignored. This lets a scenario declare the "interesting"
 * events without enumerating every Strengthened-with-source-X-and-
 * statusAfter-Y-and-… along the way. Fields omitted from an
 * `ExpectedEvent` are wildcards.
 *
 * Used in conjunction with `compareCanonical` : the comparator
 * cross-checks live vs replay, this helper checks each side against
 * the scenario's declared expectations.
 */
export function expectEventChain(actual: CapturedEvent[], expected: ExpectedEvent[]): void {
  let i = 0;
  for (const exp of expected) {
    let found = false;
    while (i < actual.length) {
      const a = actual[i];
      i++;
      if (!a) continue;
      if (a.type !== exp.type) continue;
      if (exp.statusBefore !== undefined && a.statusBefore !== exp.statusBefore) continue;
      if (exp.statusAfter !== undefined && a.statusAfter !== exp.statusAfter) continue;
      if (exp.scoreDeltaSign !== undefined && sign(a.scoreDelta) !== exp.scoreDeltaSign) continue;
      if (exp.source !== undefined && a.payloadSource !== exp.source) continue;
      found = true;
      break;
    }
    expect(found, `expected ${JSON.stringify(exp)} in event chain but not found`).toBe(true);
  }
}
