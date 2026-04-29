import { health } from "@client/api/health";
import { webLogger } from "@client/lib/logger";

const port = Number(process.env.WEB_PORT ?? 8084);

const server = Bun.serve({
  port,
  routes: {
    "/health": { GET: (req) => health(req) },
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

webLogger.info({ port: server.port }, "tf-web listening");
