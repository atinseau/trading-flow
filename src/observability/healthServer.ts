import { getLogger } from "./logger";

type BunServer = ReturnType<typeof Bun.serve>;

export type HealthStatus = "ok" | "degraded" | "down" | "standby";

export type HealthState = {
  component: string;
  status: HealthStatus;
  startedAt: Date;
  lastActivityAt: Date | null;
  metadata?: Record<string, unknown>;
};

/**
 * Lightweight HTTP sidecar exposing /health for K8s liveness probes,
 * Prometheus alerts, and basic SRE hygiene.
 *
 * GET /health → { component, status, startedAt, uptimeMs, lastActivityAt, metadata }
 *   200 when status is "ok" or "degraded"
 *   503 when status is "down"
 * GET /        → "trading-flow worker"
 * everything else → 404
 */
export class HealthServer {
  private server: BunServer | null = null;
  private state: HealthState;
  private log = getLogger({ component: "health-server" });
  private port: number;

  constructor(component: string, port: number) {
    this.port = port;
    this.state = {
      component,
      status: "ok",
      startedAt: new Date(),
      lastActivityAt: null,
    };
  }

  start(): void {
    if (this.server) return;
    const log = this.log;
    const getState = () => this.state;

    this.server = Bun.serve({
      port: this.port,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          const s = getState();
          const uptimeMs = Date.now() - s.startedAt.getTime();
          const httpStatus = s.status === "down" ? 503 : 200;
          return Response.json(
            {
              component: s.component,
              status: s.status,
              startedAt: s.startedAt.toISOString(),
              uptimeMs,
              lastActivityAt: s.lastActivityAt?.toISOString() ?? null,
              metadata: s.metadata,
            },
            { status: httpStatus },
          );
        }
        if (url.pathname === "/" || url.pathname === "") {
          return new Response("trading-flow worker", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    log.info({ port: this.actualPort, component: this.state.component }, "health server started");
  }

  setStatus(status: HealthStatus, metadata?: Record<string, unknown>): void {
    this.state.status = status;
    if (metadata !== undefined) this.state.metadata = metadata;
  }

  setActivity(): void {
    this.state.lastActivityAt = new Date();
  }

  /** Resolved port (useful when constructed with port 0 for tests). */
  get actualPort(): number {
    return this.server?.port ?? this.port;
  }

  async stop(): Promise<void> {
    this.server?.stop();
    this.server = null;
    this.log.info("health server stopped");
  }
}
