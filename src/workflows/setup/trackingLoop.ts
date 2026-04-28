import { proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "./activities";

const a = proxyActivities<ReturnType<typeof activities.buildSetupActivities>>({
  startToCloseTimeout: "30s",
});

export async function trackingLoop(setupId: string, _watchId: string): Promise<void> {
  // MVP: simple sleep then close. Full TP/SL tracking is post-MVP.
  await sleep("24h");
  await a.markSetupClosed({ setupId, finalStatus: "CLOSED" });
}
