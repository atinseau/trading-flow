// Test-only workflow harness: wraps `trackingLoop` so that the Temporal worker
// can register it as a top-level workflow. Real production code uses
// `trackingLoop` from inside `setupWorkflow`; here we exercise it in
// isolation to assert the new TrackingResult union.

import { type TrackingArgs, trackingLoop } from "../../../src/workflows/setup/trackingLoop";

export async function trackingLoopHarness(args: TrackingArgs) {
  return await trackingLoop(args);
}
