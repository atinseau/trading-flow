import { health } from "@client/api/health";
import { makeWatchesApi } from "@client/api/watches";
import { db } from "@client/lib/db";
import { webLogger } from "@client/lib/logger";
import { getTemporalClient } from "@client/lib/temporal";
import { applyReload } from "@config/applyReload";
import { bootstrapWatch } from "@config/bootstrapWatch";
import { tearDownWatch } from "@config/tearDownWatch";

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

// Adapter to bridge Bun route handlers (which receive BunRequest with .params)
// to our (req, params) handler convention.
const withParams =
  (handler: (req: Request, params: Record<string, string>) => Promise<Response>) =>
  (req: Request) =>
    handler(req, (req as Request & { params?: Record<string, string> }).params ?? {});

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
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

webLogger.info({ port: server.port }, "tf-web listening");
