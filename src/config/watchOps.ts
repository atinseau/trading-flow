import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";

const log = getLogger({ component: "watch-ops" });

export async function pauseWatch(input: { client: Client; watchId: string }): Promise<void> {
  await input.client.schedule.getHandle(`tick-${input.watchId}`).pause("paused via UI");
  log.info({ watchId: input.watchId }, "paused");
}

export async function resumeWatch(input: { client: Client; watchId: string }): Promise<void> {
  await input.client.schedule.getHandle(`tick-${input.watchId}`).unpause("resumed via UI");
  log.info({ watchId: input.watchId }, "resumed");
}

export async function forceTick(input: { client: Client; watchId: string }): Promise<void> {
  await input.client.schedule.getHandle(`tick-${input.watchId}`).trigger();
  log.info({ watchId: input.watchId }, "force-tick triggered");
}

export async function killSetup(input: {
  client: Client;
  setupId: string;
  reason: string;
}): Promise<void> {
  await input.client.workflow
    .getHandle(`setup-${input.setupId}`)
    .signal("close", { reason: input.reason });
  log.info({ setupId: input.setupId, reason: input.reason }, "kill signal sent");
}
