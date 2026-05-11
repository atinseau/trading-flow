import { BinanceFetcher } from "@adapters/market-data/BinanceFetcher";
import { YahooFinanceFetcher } from "@adapters/market-data/YahooFinanceFetcher";
import { PostgresLiveEventQueryByWindow } from "@adapters/persistence/PostgresLiveEventQueryByWindow";
import { PostgresLLMResponseCacheStore } from "@adapters/persistence/PostgresLLMResponseCacheStore";
import { PostgresReplayEventStore } from "@adapters/persistence/PostgresReplayEventStore";
import { PostgresReplayLLMCallStore } from "@adapters/persistence/PostgresReplayLLMCallStore";
import { PostgresReplaySessionRepository } from "@adapters/persistence/PostgresReplaySessionRepository";
import { PostgresWatchRepository } from "@adapters/persistence/PostgresWatchRepository";
import { TemporalScheduleController } from "@adapters/temporal/TemporalScheduleController";
import { SystemClock } from "@adapters/time/SystemClock";
import { makeAdminApi } from "@client/api/admin";
import { assetOhlcv } from "@client/api/assets";
import { makeCostsApi } from "@client/api/costs";
import { makeEventsApi } from "@client/api/events";
import { health } from "@client/api/health";
import { makeLessonsApi } from "@client/api/lessons";
import { makePerfApi } from "@client/api/perf";
import { makeReplayApi } from "@client/api/replay";
import { search } from "@client/api/search";
import { makeSetupsApi } from "@client/api/setups";
import { makeStreamHandler } from "@client/api/stream";
import { makeTicksApi } from "@client/api/ticks";
import { makeWatchesApi } from "@client/api/watches";
import { yahooLookup } from "@client/api/yahoo";
import { broadcaster } from "@client/lib/broadcaster";
import { db, pool } from "@client/lib/db";
import { webLogger } from "@client/lib/logger";
import { startPoller } from "@client/lib/poller";
import { getTemporalClient } from "@client/lib/temporal";
import { applyReload } from "@config/applyReload";
import { bootstrapWatch } from "@config/bootstrapWatch";
import { tearDownWatch } from "@config/tearDownWatch";
import { forceTick, killSetup, pauseWatch, resumeWatch } from "@config/watchOps";
import {
  type ReplaySignalSender,
  TemporalReplaySignalSender,
} from "@workflows/replay/replaySignals";
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
        clock: new SystemClock(),
        scheduleController: new TemporalScheduleController(client),
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
const lessonsApi = makeLessonsApi({ db });
const perfApi = makePerfApi({ db });

// Replay API — Jalon 1: no Temporal client wired yet (step/pause/resume
// endpoints will be added in Jalon 2). Activities and adapters are
// composed here from the shared `db` to keep the wiring single-shot.
const replayMarketDataFetchers = new Map<
  string,
  import("@domain/ports/MarketDataFetcher").MarketDataFetcher
>();
replayMarketDataFetchers.set("binance", new BinanceFetcher());
replayMarketDataFetchers.set("yahoo", new YahooFinanceFetcher());
/**
 * Lazy signaller — the Temporal client is created on first call and
 * cached. Avoids forcing a Temporal connection on web boot when the user
 * only ever browses live data (the schedulerWorker + analysisWorker
 * already do the same lazy pattern via getTemporalClient).
 */
const REPLAY_TASK_QUEUE = process.env.REPLAY_TASK_QUEUE ?? "replay";
let cachedSignaller: ReplaySignalSender | null = null;
async function getReplaySignaller(): Promise<ReplaySignalSender> {
  if (cachedSignaller) return cachedSignaller;
  const client = await getTemporalClient();
  cachedSignaller = new TemporalReplaySignalSender(client, REPLAY_TASK_QUEUE);
  return cachedSignaller;
}

/**
 * Lazy-resolving signaller façade. The API holds this object at boot ;
 * each method resolves the underlying client only when actually
 * invoked, keeping web startup fast.
 */
const replaySignaller: ReplaySignalSender = {
  step: (args) => getReplaySignaller().then((s) => s.step(args)),
  pause: (args) => getReplaySignaller().then((s) => s.pause(args)),
  resume: (args) => getReplaySignaller().then((s) => s.resume(args)),
  terminate: (args) => getReplaySignaller().then((s) => s.terminate(args)),
};

const replayApi = makeReplayApi({
  sessionsRepo: new PostgresReplaySessionRepository(db),
  replayEventStore: new PostgresReplayEventStore(db),
  replayLlmCallStore: new PostgresReplayLLMCallStore(db),
  cacheStore: new PostgresLLMResponseCacheStore(db),
  liveEventQuery: new PostgresLiveEventQueryByWindow(db),
  watchRepo: new PostgresWatchRepository(db),
  marketDataFetchers: replayMarketDataFetchers,
  clock: new SystemClock(),
  signaller: replaySignaller,
});

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
    "/api/setups/stats": { GET: (req) => setupsApi.stats(req) },
    "/api/setups/:id": { GET: withParams(setupsApi.get) },
    "/api/setups/:id/events": { GET: withParams(setupsApi.events) },
    "/api/setups/:id/llm-calls": { GET: withParams(setupsApi.llmCalls) },
    "/api/setups/:id/ohlcv": { GET: withParams(setupsApi.ohlcv) },
    "/api/events": { GET: (req) => eventsApi.list(req) },
    "/api/ticks": { GET: (req) => ticksApi.list(req) },
    "/api/ticks/:id/chart.png": { GET: withParams(ticksApi.chartPng) },
    "/api/costs": { GET: (req) => costsApi.aggregations(req) },
    "/api/perf": { GET: (req) => perfApi.perf(req) },
    "/api/replay/sessions": {
      GET: (req) => replayApi.list(req),
      POST: (req) => replayApi.create(req),
    },
    "/api/replay/sessions/:id": {
      GET: withParams(replayApi.get),
      DELETE: withParams(replayApi.delete),
    },
    "/api/replay/sessions/:id/events": { GET: withParams(replayApi.events) },
    "/api/replay/sessions/:id/setups": { GET: withParams(replayApi.setupsProjection) },
    "/api/replay/sessions/:id/ohlcv": { GET: withParams(replayApi.ohlcv) },
    "/api/replay/sessions/:id/cost-breakdown": { GET: withParams(replayApi.costBreakdown) },
    "/api/replay/sessions/:id/llm-calls": { GET: withParams(replayApi.llmCalls) },
    "/api/replay/sessions/:id/step": { POST: withParams(replayApi.step) },
    "/api/replay/sessions/:id/pause": { POST: withParams(replayApi.pause) },
    "/api/replay/sessions/:id/resume": { POST: withParams(replayApi.resume) },
    "/api/replay/sessions/:id/terminate": { POST: withParams(replayApi.terminate) },
    "/api/watches/:id/force-tick": { POST: withParams(adminApi.forceTick) },
    "/api/watches/:id/pause": { POST: withParams(adminApi.pause) },
    "/api/watches/:id/resume": { POST: withParams(adminApi.resume) },
    "/api/setups/:id/kill": { POST: withParams(adminApi.killSetup) },
    "/api/setups/:id/lessons": { GET: withParams(lessonsApi.listEventsForSetup) },
    "/api/watches/:id/lessons": { GET: withParams(lessonsApi.listForWatch) },
    "/api/watches/:id/lessons/counts": { GET: withParams(lessonsApi.countsForWatch) },
    "/api/lessons": { GET: (req) => lessonsApi.listAll(req) },
    "/api/lessons/counts": { GET: (req) => lessonsApi.countsGlobal(req) },
    "/api/lessons/:id": { GET: withParams(lessonsApi.get) },
    "/api/lessons/:id/approve": { POST: withParams(lessonsApi.approve) },
    "/api/lessons/:id/reject": { POST: withParams(lessonsApi.reject) },
    "/api/lessons/:id/pin": { POST: withParams(lessonsApi.pin) },
    "/api/lessons/:id/unpin": { POST: withParams(lessonsApi.unpin) },
    "/api/lessons/:id/archive": { POST: withParams(lessonsApi.archive) },
    "/api/stream": { GET: makeStreamHandler({ broadcaster }) },
    "/api/search": { GET: (req) => search(req) },
    "/api/assets/:source/:symbol/ohlcv": { GET: (req) => assetOhlcv(req) },
    "/api/yahoo/lookup": { GET: (req) => yahooLookup(req) },
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
