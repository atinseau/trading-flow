import type { WatchRepository } from "@domain/ports/WatchRepository";
import { getSession, type Session, sessionKey } from "@domain/services/marketSession";
import { getLogger } from "@observability/logger";
import type { Client } from "@temporalio/client";
import { WorkflowNotFoundError } from "@temporalio/client";
import { marketClockWorkflow, marketClockWorkflowId } from "./marketClockWorkflow";

const log = getLogger({ component: "ensure-market-clock" });
const ALREADY_RUNNING = /already running|already started|alreadystarted/i;

/**
 * Ensure a market-clock workflow is running for the given session.
 * Idempotent: if one is already running with the same id, this is a no-op.
 * No-op for `always-open` sessions (crypto / FUTURE / CRYPTOCURRENCY).
 */
export async function ensureMarketClock(deps: {
  client: Client;
  taskQueue: string;
  session: Session;
}): Promise<void> {
  const { client, taskQueue, session } = deps;
  if (session.kind === "always-open") return;
  const id = marketClockWorkflowId(session);

  // Fast path: check if already RUNNING.
  try {
    const handle = client.workflow.getHandle(id);
    const desc = await handle.describe();
    if (desc.status.name === "RUNNING") return;
    // If COMPLETED/CANCELLED/FAILED, fall through to start a fresh one.
  } catch (e) {
    if (!(e instanceof WorkflowNotFoundError)) throw e;
    // not found → fall through to start
  }

  try {
    await client.workflow.start(marketClockWorkflow, {
      workflowId: id,
      taskQueue,
      args: [{ session }],
    });
    log.info({ id, session: sessionKey(session) }, "started market clock workflow");
  } catch (err) {
    if (ALREADY_RUNNING.test((err as Error).message)) {
      // Race with another caller — they got there first. Fine.
      return;
    }
    throw err;
  }
}

/**
 * At worker startup, enumerate distinct sessions across all enabled watches
 * and start a clock for each (skipping always-open).
 */
export async function bootstrapMarketClocks(deps: {
  client: Client;
  taskQueue: string;
  watches: WatchRepository;
}): Promise<void> {
  const { client, taskQueue, watches } = deps;
  const all = await watches.findEnabled();
  const sessions = new Map<string, Session>();
  for (const w of all) {
    let s: Session;
    try {
      s = getSession(w);
    } catch (e) {
      // Invalid watch (unknown exchange) — skipped silently here; surfaced
      // via the UI badge through findAllWithValidation elsewhere.
      log.warn({ watchId: w.id, err: (e as Error).message }, "skipping watch with invalid session");
      continue;
    }
    if (s.kind === "always-open") continue;
    sessions.set(sessionKey(s), s);
  }
  log.info({ count: sessions.size }, "bootstrapping market clocks");
  for (const session of sessions.values()) {
    await ensureMarketClock({ client, taskQueue, session });
  }
}
