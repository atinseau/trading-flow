import { makeAdminApi } from "@client/api/admin";
import { assetOhlcv } from "@client/api/assets";
import { makeCostsApi } from "@client/api/costs";
import { makeEventsApi } from "@client/api/events";
import { health } from "@client/api/health";
import { search } from "@client/api/search";
import { makeSetupsApi } from "@client/api/setups";
import { makeStreamHandler } from "@client/api/stream";
import { makeTicksApi } from "@client/api/ticks";
import { makeWatchesApi } from "@client/api/watches";
import { broadcaster } from "@client/lib/broadcaster";
import { db, pool } from "@client/lib/db";
import { webLogger } from "@client/lib/logger";
import { startPoller } from "@client/lib/poller";
import { getTemporalClient } from "@client/lib/temporal";
import { applyReload } from "@config/applyReload";
import { bootstrapWatch } from "@config/bootstrapWatch";
import { tearDownWatch } from "@config/tearDownWatch";
import { forceTick, killSetup, pauseWatch, resumeWatch } from "@config/watchOps";
import index from "./index.html";

const port = Number(process.env.WEB_PORT ?? 8084);

const watchesApi = makeWatchesApi({
  db,
  hooks: {
    bootstrap: async (watch) => {
      const client = await getTemporalClient();
      await bootstrapWatch(watch, {
        client,
        taskQueues: {
          scheduler: process.env.TEMPORAL_TASK_QUEUE_SCHEDULER ?? "scheduler",
          analysis: process.env.TEMPORAL_TASK_QUEUE_ANALYSIS ?? "analysis",
          notifications: process.env.TEMPORAL_TASK_QUEUE_NOTIFICATIONS ?? "notifications",
        },
      });
    },
    applyReload: async (watch, previous) => {
      const client = await getTemporalClient();
      await applyReload({ client, watch, previous });
    },
    tearDown: async (watchId) => {
      const client = await getTemporalClient();
      await tearDownWatch({ client, watchId });
    },
  },
});

const setupsApi = makeSetupsApi({ db });
const eventsApi = makeEventsApi({ db });
const ticksApi = makeTicksApi({ db });
const costsApi = makeCostsApi({ db });

const adminApi = makeAdminApi({
  ops: {
    forceTick: async ({ watchId }) => {
      const client = await getTemporalClient();
      await forceTick({ client, watchId });
    },
    pauseWatch: async ({ watchId }) => {
      const client = await getTemporalClient();
      await pauseWatch({ client, watchId });
    },
    resumeWatch: async ({ watchId }) => {
      const client = await getTemporalClient();
      await resumeWatch({ client, watchId });
    },
    killSetup: async ({ setupId, reason }) => {
      const client = await getTemporalClient();
      await killSetup({ client, setupId, reason });
    },
  },
});

// Adapter to bridge Bun route handlers (which receive BunRequest with .params)
// to our (req, params) handler convention.
const withParams =
  (handler: (req: Request, params: Record<string, string>) => Promise<Response>) =>
  (req: Request) =>
    handler(req, (req as Request & { params?: Record<string, string> }).params ?? {});

const stopPoller = startPoller({
  pool,
  broadcaster,
  intervalMs: Number(process.env.TF_WEB_POLL_INTERVAL_MS ?? 1500),
  batchSize: Number(process.env.TF_WEB_POLL_BATCH_SIZE ?? 200),
});
process.on("SIGTERM", () => stopPoller());
process.on("SIGINT", () => stopPoller());

const server = Bun.serve({
  port,
  routes: {
    "/health": { GET: (req) => health(req) },
    "/api/watches": {
      GET: (req) => watchesApi.list(req),
      POST: (req) => watchesApi.create(req),
    },
    "/api/watches/:id": {
      GET: withParams(watchesApi.get),
      PUT: withParams(watchesApi.update),
      DELETE: withParams(watchesApi.del),
    },
    "/api/watches/:id/revisions": {
      GET: withParams(watchesApi.revisions),
    },
    "/api/setups": { GET: (req) => setupsApi.list(req) },
    "/api/setups/:id": { GET: withParams(setupsApi.get) },
    "/api/setups/:id/events": { GET: withParams(setupsApi.events) },
    "/api/setups/:id/ohlcv": { GET: withParams(setupsApi.ohlcv) },
    "/api/events": { GET: (req) => eventsApi.list(req) },
    "/api/ticks": { GET: (req) => ticksApi.list(req) },
    "/api/ticks/:id/chart.png": { GET: withParams(ticksApi.chartPng) },
    "/api/costs": { GET: (req) => costsApi.aggregations(req) },
    "/api/watches/:id/force-tick": { POST: withParams(adminApi.forceTick) },
    "/api/watches/:id/pause": { POST: withParams(adminApi.pause) },
    "/api/watches/:id/resume": { POST: withParams(adminApi.resume) },
    "/api/setups/:id/kill": { POST: withParams(adminApi.killSetup) },
    "/api/stream": { GET: makeStreamHandler({ broadcaster }) },
    "/api/search": { GET: (req) => search(req) },
    "/api/assets/:source/:symbol/ohlcv": { GET: (req) => assetOhlcv(req) },
    // Unknown /api/* → 404 JSON (must come before the SPA catch-all so it
    // wins for paths starting with /api/).
    "/api/*": () => Response.json({ error: "not found" }, { status: 404 }),
    // SPA fallback — any other path serves the React shell so
    // react-router-dom can handle the client-side route on page reloads
    // and direct URL hits.
    "/*": index,
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

webLogger.info({ port: server.port }, "tf-web listening");
